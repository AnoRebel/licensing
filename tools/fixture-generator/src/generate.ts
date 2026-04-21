/**
 * Deterministic fixture generator.
 *
 *   inputs.json  →  { canonical_header.bin, canonical_payload.bin,
 *                     expected_token.txt }
 *
 * Builds a LIC1 token *manually* (canonicalize → base64url → sign → join)
 * rather than going through `@anorebel/licensing`'s `lic1.encode` helper. Two
 * reasons:
 *   1. The tamper generator reuses this exact path and needs to emit tokens
 *      that the core would refuse to encode (unknown fields, missing claims,
 *      etc.). Going through the helper would block those cases.
 *   2. Byte-for-byte control over what lands on disk. The fixture contract
 *      is byte-equality; we don't want any helper layer to massage output.
 *
 * All the crypto still comes from `@anorebel/licensing/crypto` — we are not
 * reimplementing signing. We *are* reimplementing the envelope glue, and
 * the assertion in `verifyAgainstCore()` at the bottom closes the loop: the
 * resulting token MUST parse-and-verify through `lic1.verify` before we
 * write it to disk. If it doesn't, generation fails loud.
 */

import { canonicalize } from '@anorebel/licensing/canonical-json';
import {
  ed25519Backend,
  hmacBackend,
  rsaPssBackend,
  type SignatureBackend,
} from '@anorebel/licensing/crypto';
import { decodeUnverified } from '@anorebel/licensing/lic1';

import { loadKey } from './keys.ts';
import type { KeyAlg, ValidInputs } from './types.ts';

const TEXT_ENCODER = new TextEncoder();

export interface GeneratedToken {
  readonly canonicalHeader: Uint8Array;
  readonly canonicalPayload: Uint8Array;
  readonly token: string;
}

/** Build canonical bytes + LIC1 token from `inputs.json` + key material on disk.
 *  Performs consistency checks (alg/kid mismatch between inputs and header)
 *  and verifies the produced token round-trips through the core. */
export async function generate(fixturesDir: string, inputs: ValidInputs): Promise<GeneratedToken> {
  // Sanity: the header fields must match the top-level alg/kid. Mismatches
  // indicate an authoring typo — fail before signing anything.
  if (inputs.header.alg !== inputs.alg) {
    throw new Error(
      `inputs.alg=${inputs.alg} but inputs.header.alg=${String(inputs.header.alg)} — fix the vector`,
    );
  }
  if (inputs.header.kid !== inputs.kid) {
    throw new Error(
      `inputs.kid=${inputs.kid} but inputs.header.kid=${String(inputs.header.kid)} — fix the vector`,
    );
  }

  const canonicalHeader = canonicalize(inputs.header);
  const canonicalPayload = canonicalize(inputs.payload);
  const headerB64 = b64urlEncode(canonicalHeader);
  const payloadB64 = b64urlEncode(canonicalPayload);
  const signingInput = TEXT_ENCODER.encode(`${headerB64}.${payloadB64}`);

  const backend = backendFor(inputs.alg);
  const loaded = loadKey(fixturesDir, inputs.key_ref, inputs.alg);
  const priv = await backend.importPrivate(loaded.material);
  const sig = await backend.sign(priv, signingInput);
  const token = `LIC1.${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;

  await verifyAgainstCore(
    { alg: inputs.alg, kid: inputs.kid, keyRef: inputs.key_ref, token },
    fixturesDir,
  );

  return { canonicalHeader, canonicalPayload, token };
}

/** Build canonical bytes + signature over arbitrary (possibly malformed) header
 *  + payload JSON. Used by the tamper generator to produce vectors that the
 *  core would reject. Skips the round-trip verification on purpose. */
export async function generateRaw(
  fixturesDir: string,
  alg: KeyAlg,
  keyRef: ValidInputs['key_ref'],
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<GeneratedToken> {
  const canonicalHeader = canonicalize(header);
  const canonicalPayload = canonicalize(payload);
  const headerB64 = b64urlEncode(canonicalHeader);
  const payloadB64 = b64urlEncode(canonicalPayload);
  const signingInput = TEXT_ENCODER.encode(`${headerB64}.${payloadB64}`);

  const backend = backendFor(alg);
  const loaded = loadKey(fixturesDir, keyRef, alg);
  const priv = await backend.importPrivate(loaded.material);
  const sig = await backend.sign(priv, signingInput);
  const token = `LIC1.${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;

  return { canonicalHeader, canonicalPayload, token };
}

function backendFor(alg: KeyAlg): SignatureBackend {
  switch (alg) {
    case 'ed25519':
      return ed25519Backend;
    case 'rs256-pss':
      return rsaPssBackend;
    case 'hs256':
      return hmacBackend;
  }
}

/** base64url encode without `=` padding (RFC 4648 §5). */
function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

interface VerifyCtx {
  readonly alg: KeyAlg;
  readonly kid: string;
  readonly keyRef: ValidInputs['key_ref'];
  readonly token: string;
}

/** Round-trip: re-decode the token, import the matching public key, and
 *  verify the signature through the backend. We intentionally bypass
 *  `lic1.verify` here — it expects a `KeyRecord` shape that conflicts with
 *  HMAC's raw-only `importPublic` contract — and drive the backend directly.
 *  The goal is to catch canonicalization/envelope drift between this tool
 *  and the core; signature semantics are already covered by the core's own
 *  per-backend tests. */
async function verifyAgainstCore(ctx: VerifyCtx, fixturesDir: string): Promise<void> {
  const parts = decodeUnverified(ctx.token);
  const backend = backendFor(ctx.alg);
  const loaded = loadKey(fixturesDir, ctx.keyRef, ctx.alg);
  // Hand the backend whichever shape it expects. Ed25519/RSA accept PEM;
  // HMAC rejects PEM and accepts raw. `loaded.material` already encodes that.
  const pub = await backend.importPublic(loaded.material);
  const ok = await backend.verify(pub, parts.signingInput, parts.signature);
  if (!ok) {
    throw new Error(
      `generated token failed self-verify for kid=${ctx.kid} alg=${ctx.alg} — ` +
        'canonicalization or envelope has drifted from the core',
    );
  }
}
