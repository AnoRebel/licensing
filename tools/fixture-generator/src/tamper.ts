/**
 * Tamper-variant generator.
 *
 * Given a valid vector + a list of `TamperSpec`s, emit sibling directories
 * under `fixtures/tokens-invalid/<nnn>-<variant>/` whose contents are each
 * mutated in a well-defined way:
 *
 *   - header-bitflip   — flip one bit in the signed canonical header
 *   - payload-bitflip  — flip one bit in the signed canonical payload
 *   - sig-bitflip      — flip one bit in the signature segment
 *   - wrong-kid        — re-sign with the declared alg but advertise a kid
 *                        that the validator's bindings don't know
 *   - missing-required-claim — delete a named claim and re-sign
 *   - expired          — shift `exp` to a past second and re-sign
 *   - nbf-in-future    — shift `nbf` far in the future and re-sign
 *
 * "Re-sign" means: produce a valid LIC1 envelope with the mutated payload so
 * the *signature* still verifies — only the timestamp / kid triggers
 * rejection. That's the interesting test case: a signature-verify shortcut
 * shouldn't save you from an expired-but-signed token.
 *
 * The bitflip variants are different: they mutate *after* signing, so the
 * signature no longer matches. Those test that validators don't accept
 * bytewise corruption of signed material.
 */

import { decode as b64urlDecode } from '@anorebel/licensing/base64url';

import { type GeneratedToken, generateRaw } from './generate.ts';
import type { TamperSpec, ValidInputs } from './types.ts';

/** Produce the tampered vector for a given spec. Returns the raw outputs the
 *  caller should write to the variant's directory. */
export async function tamper(
  fixturesDir: string,
  inputs: ValidInputs,
  source: GeneratedToken,
  spec: TamperSpec,
): Promise<GeneratedToken> {
  switch (spec.kind) {
    case 'header-bitflip':
      return bitflipInHeader(source);
    case 'payload-bitflip':
      return bitflipInPayload(source);
    case 'sig-bitflip':
      return bitflipInSignature(source);
    case 'wrong-kid':
      return wrongKid(fixturesDir, inputs, spec.substituteKid ?? 'not-a-real-kid');
    case 'missing-required-claim': {
      if (!spec.claim) throw new Error(`missing-required-claim tamper requires a "claim" field`);
      return missingClaim(fixturesDir, inputs, spec.claim);
    }
    case 'expired':
      return expired(fixturesDir, inputs);
    case 'nbf-in-future':
      return nbfInFuture(fixturesDir, inputs);
  }
}

/** Split a LIC1 token into its four segments; narrows the tuple shape so
 *  callers don't need non-null assertions. Throws on malformed input. */
function splitLic1(token: string): [string, string, string, string] {
  const parts = token.split('.');
  if (parts.length !== 4) throw new Error('source token is not a 4-part LIC1 token');
  const [prefix, header, payload, sig] = parts as [string, string, string, string];
  return [prefix, header, payload, sig];
}

function bitflipInHeader(src: GeneratedToken): GeneratedToken {
  const [prefix, header, payload, sig] = splitLic1(src.token);
  // Flip a bit in the base64url-encoded header; the header still base64url-
  // decodes to valid bytes but the JSON underneath is corrupted, which breaks
  // signature verification and/or header parsing. Use the core's strict
  // base64url decoder (not Node's Buffer) so tool and core agree on alphabet
  // rules for the written canonical bytes.
  const flipped = flipBase64urlBit(header);
  return {
    canonicalHeader: b64urlDecode(flipped),
    canonicalPayload: src.canonicalPayload,
    token: `${prefix}.${flipped}.${payload}.${sig}`,
  };
}

function bitflipInPayload(src: GeneratedToken): GeneratedToken {
  const [prefix, header, payload, sig] = splitLic1(src.token);
  const flipped = flipBase64urlBit(payload);
  return {
    canonicalHeader: src.canonicalHeader,
    canonicalPayload: b64urlDecode(flipped),
    token: `${prefix}.${header}.${flipped}.${sig}`,
  };
}

function bitflipInSignature(src: GeneratedToken): GeneratedToken {
  const [prefix, header, payload, sig] = splitLic1(src.token);
  const flipped = flipBase64urlBit(sig);
  return {
    canonicalHeader: src.canonicalHeader,
    canonicalPayload: src.canonicalPayload,
    token: `${prefix}.${header}.${payload}.${flipped}`,
  };
}

async function wrongKid(
  fixturesDir: string,
  inputs: ValidInputs,
  substitute: string,
): Promise<GeneratedToken> {
  const header = { ...inputs.header, kid: substitute };
  return generateRaw(fixturesDir, inputs.alg, inputs.key_ref, header, inputs.payload);
}

async function missingClaim(
  fixturesDir: string,
  inputs: ValidInputs,
  claim: string,
): Promise<GeneratedToken> {
  // Guard against authors naming a *header* claim here — the core rejects
  // headers with missing required fields at decode time, not at claim-check
  // time, which would throw inside the test harness's claim-only branch
  // (which does not wrap decodeUnverified in try/catch). If a header-field
  // tamper is ever needed, add a new TamperSpec.kind for it.
  const HEADER_FIELDS = new Set(['v', 'typ', 'alg', 'kid']);
  if (HEADER_FIELDS.has(claim)) {
    throw new Error(
      `missing-required-claim targets payload claims only; "${claim}" is a header field. ` +
        'Add a dedicated TamperSpec.kind if you want to exercise header-field removal.',
    );
  }
  if (!(claim in inputs.payload)) {
    throw new Error(`cannot delete missing claim "${claim}" — not present in source payload`);
  }
  const payload: Record<string, unknown> = { ...inputs.payload };
  delete payload[claim];
  return generateRaw(fixturesDir, inputs.alg, inputs.key_ref, inputs.header, payload);
}

async function expired(fixturesDir: string, inputs: ValidInputs): Promise<GeneratedToken> {
  // 2000-01-01 UTC — comfortably before any plausible "now" a validator uses.
  const payload: Record<string, unknown> = { ...inputs.payload, exp: 946684800 };
  return generateRaw(fixturesDir, inputs.alg, inputs.key_ref, inputs.header, payload);
}

async function nbfInFuture(fixturesDir: string, inputs: ValidInputs): Promise<GeneratedToken> {
  // 2100-01-01 UTC — comfortably after any plausible "now".
  const payload: Record<string, unknown> = { ...inputs.payload, nbf: 4102444800 };
  return generateRaw(fixturesDir, inputs.alg, inputs.key_ref, inputs.header, payload);
}

// ---------- base64url helpers ----------

/** Base64url alphabet in canonical order. */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Replace the FIRST character of a base64url string with a different
 *  alphabet entry. Using the first character is critical: the last character
 *  of a length-mod-4 = 2 or 3 string contributes only partial bits (the high
 *  bits) to the decoded bytes, so flipping a low-order alphabet bit on the
 *  final char can be a no-op on the byte stream — which would fail to break
 *  a signature. The first char always contributes its full 6 bits to the
 *  decoded output. */
function flipBase64urlBit(s: string): string {
  const first = s[0];
  if (first === undefined) throw new Error('cannot flip bit of empty base64url segment');
  const idx = B64URL.indexOf(first);
  if (idx < 0) throw new Error(`non-base64url char "${first}" at head`);
  // XOR the high bit of the 6-bit index — guaranteed to land in a full-byte
  // position at the start of the decoded stream.
  const substitute = B64URL[idx ^ 0x20];
  if (substitute === undefined) throw new Error('alphabet index out of range (unreachable)');
  return substitute + s.slice(1);
}
