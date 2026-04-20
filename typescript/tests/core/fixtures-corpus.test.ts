/**
 * Consume every vector under `fixtures/tokens/` and `fixtures/tokens-invalid/`,
 * asserting the core agrees byte-for-byte on canonicalization, signature
 * production (for deterministic algs), and rejection of tampered siblings.
 *
 * This is the cross-language interop contract enforced locally — the Go port
 * will run the equivalent assertions against the same files. If either side
 * diverges, the corpus fails both CIs.
 *
 * Vector layout:
 *   inputs.json             → authored
 *   canonical_header.bin    → expected bytes
 *   canonical_payload.bin   → expected bytes
 *   expected_token.txt      → expected full LIC1 token + trailing \n
 *
 * Tamper layout:
 *   token.txt               → tampered token + trailing \n
 *   spec.json               → { source, variant, kind, ... }
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalize,
  decodeUnverified,
  ed25519Backend,
  hmacBackend,
  type PemKeyMaterial,
  type RawKeyMaterial,
  rsaPssBackend,
  type SignatureBackend,
} from '../../src/index.ts';

const FIXTURES_ROOT = join(import.meta.dir, '../../../fixtures');
const TOKENS_DIR = join(FIXTURES_ROOT, 'tokens');
const TOKENS_INVALID_DIR = join(FIXTURES_ROOT, 'tokens-invalid');

type KeyAlg = 'ed25519' | 'rs256-pss' | 'hs256';
type KeyRef = 'ed25519' | 'rsa' | 'hmac';

interface Inputs {
  alg: KeyAlg;
  kid: string;
  key_ref: KeyRef;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function listVectors(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((e) => /^[0-9]{3}/.test(e))
      .sort();
  } catch {
    return [];
  }
}

function loadVector(id: string): {
  inputs: Inputs;
  canonicalHeader: Uint8Array;
  canonicalPayload: Uint8Array;
  expectedToken: string;
} {
  const dir = join(TOKENS_DIR, id);
  const inputs: Inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  const canonicalHeader = new Uint8Array(readFileSync(join(dir, 'canonical_header.bin')));
  const canonicalPayload = new Uint8Array(readFileSync(join(dir, 'canonical_payload.bin')));
  const expectedToken = readFileSync(join(dir, 'expected_token.txt'), 'utf8').replace(/\n$/, '');
  return { inputs, canonicalHeader, canonicalPayload, expectedToken };
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

function loadKey(ref: KeyRef, alg: KeyAlg): PemKeyMaterial | RawKeyMaterial {
  const base = join(FIXTURES_ROOT, 'keys', ref);
  if (alg === 'hs256') {
    const hex = readFileSync(join(base, 'secret.hex'), 'utf8').trim();
    const raw = Buffer.from(hex, 'hex');
    const u8 = new Uint8Array(raw);
    return { privateRaw: u8, publicRaw: u8 };
  }
  return {
    privatePem: readFileSync(join(base, 'private.pem'), 'utf8'),
    publicPem: readFileSync(join(base, 'public.pem'), 'utf8'),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const vectors = listVectors(TOKENS_DIR);

// The corpus must populate before the tests run — this catches an empty
// fixtures/tokens/ dir (which would make the whole suite a no-op).
describe('fixtures corpus — sanity', () => {
  it('has at least 24 vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(24);
  });
});

describe.each(vectors)('vector %s — canonicalization', (id) => {
  const v = loadVector(id);

  it('canonicalize(header) === canonical_header.bin', () => {
    const actual = canonicalize(v.inputs.header);
    expect(bytesEqual(actual, v.canonicalHeader)).toBe(true);
  });

  it('canonicalize(payload) === canonical_payload.bin', () => {
    const actual = canonicalize(v.inputs.payload);
    expect(bytesEqual(actual, v.canonicalPayload)).toBe(true);
  });
});

describe.each(vectors)('vector %s — envelope', (id) => {
  const v = loadVector(id);

  it('expected_token.txt parses as a LIC1 envelope with the declared alg + kid', () => {
    const parts = decodeUnverified(v.expectedToken);
    expect(parts.header.alg).toBe(v.inputs.alg);
    expect(parts.header.kid).toBe(v.inputs.kid);
  });

  it('signature verifies against the fixture key', async () => {
    const parts = decodeUnverified(v.expectedToken);
    const backend = backendFor(v.inputs.alg);
    const pub = await backend.importPublic(loadKey(v.inputs.key_ref, v.inputs.alg));
    const ok = await backend.verify(pub, parts.signingInput, parts.signature);
    expect(ok).toBe(true);
  });
});

// Ed25519 + HMAC are deterministic — the expected token should byte-match
// a freshly signed one. RSA-PSS uses random salts, so we only check verify().
describe.each(
  vectors.filter((id) => !id.includes('rs256-pss')),
)('vector %s — deterministic signature byte-match', (id) => {
  const v = loadVector(id);
  it('produces the exact expected_token bytes', async () => {
    const backend = backendFor(v.inputs.alg);
    const priv = await backend.importPrivate(loadKey(v.inputs.key_ref, v.inputs.alg));
    const headerB64 = Buffer.from(canonicalize(v.inputs.header)).toString('base64url');
    const payloadB64 = Buffer.from(canonicalize(v.inputs.payload)).toString('base64url');
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = await backend.sign(priv, signingInput);
    const token = `LIC1.${headerB64}.${payloadB64}.${Buffer.from(sig).toString('base64url')}`;
    expect(token).toBe(v.expectedToken);
  });
});

// Tamper vectors: every invalid sibling MUST fail to verify. We don't assert
// a specific error class here (the core's per-alg tests cover that) — only
// that a verifier can't be tricked into accepting the tampered material.
const invalidVectors = listVectors(TOKENS_INVALID_DIR);

/** The TamperSpec.kind union from `tools/fixture-generator/src/types.ts`.
 *  Kept in sync by hand — the coverage test below guarantees every listed
 *  kind has at least one vector in the corpus. If a new kind lands, add it
 *  here AND ship at least one vector; CI will fail until both are present. */
const ALL_TAMPER_KINDS = [
  'header-bitflip',
  'payload-bitflip',
  'sig-bitflip',
  'wrong-kid',
  'missing-required-claim',
  'expired',
  'nbf-in-future',
] as const;

describe('tamper corpus — sanity', () => {
  it('has at least 21 tamper variants (3 baseline × 7 kinds)', () => {
    expect(invalidVectors.length).toBeGreaterThanOrEqual(21);
  });

  // Finding #6: count alone is insufficient. A future refactor that deletes
  // the 'expired' variant but adds two 'sig-bitflip' variants would keep the
  // count ≥ 21 while silently dropping type coverage. This assertion catches
  // that.
  it('covers every TamperSpec.kind', () => {
    const kinds = new Set(
      invalidVectors.map((id) => {
        const spec = JSON.parse(
          readFileSync(join(TOKENS_INVALID_DIR, id, 'spec.json'), 'utf8'),
        ) as { kind: string };
        return spec.kind;
      }),
    );
    for (const kind of ALL_TAMPER_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }
  });
});

describe.each(invalidVectors)('tamper %s — rejected', (id) => {
  const dir = join(TOKENS_INVALID_DIR, id);
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as {
    source: string;
    variant: string;
    kind: string;
  };
  const token = readFileSync(join(dir, 'token.txt'), 'utf8').replace(/\n$/, '');
  // Finding #5: assert the manifest's `source` points at a real vector
  // BEFORE attempting to read `inputs.json` from it. Without this, a typoed
  // source id produces a cryptic ENOENT instead of a test-level assertion
  // failure pointing at the tamper dir.
  if (!vectors.includes(spec.source)) {
    it(`has a valid spec.source (${spec.source} must be a vector under fixtures/tokens/)`, () => {
      expect(vectors).toContain(spec.source);
    });
    return;
  }
  const srcInputs: Inputs = JSON.parse(
    readFileSync(join(TOKENS_DIR, spec.source, 'inputs.json'), 'utf8'),
  );

  it('fails decode OR signature verification OR surfaces a claim defect', async () => {
    // Tamper taxonomy:
    //   - header-bitflip / payload-bitflip: mutation often corrupts JSON/UTF-8,
    //     causing `decodeUnverified` to throw. If the mutation happens to land
    //     on bytes that still decode, signature verification MUST fail.
    //   - sig-bitflip: decode succeeds, signature verification fails.
    //   - wrong-kid / missing-required-claim / expired / nbf-in-future:
    //     decode succeeds, signature verifies (we re-sign after mutation),
    //     but the payload content carries the defect. Rejection is the claim
    //     validator's responsibility (phase 5).
    const cryptoFails = new Set(['header-bitflip', 'payload-bitflip', 'sig-bitflip']);
    if (cryptoFails.has(spec.kind)) {
      let parts: ReturnType<typeof decodeUnverified>;
      try {
        parts = decodeUnverified(token);
      } catch {
        // Decode-level rejection is an acceptable outcome — assertion
        // satisfied by the throw.
        return;
      }
      const backend = backendFor(srcInputs.alg);
      const pub = await backend.importPublic(loadKey(srcInputs.key_ref, srcInputs.alg));
      const ok = await backend.verify(pub, parts.signingInput, parts.signature);
      expect(ok).toBe(false);
      return;
    }
    // Claim-only tampers: decode and check the payload differs from the
    // source in the expected way. Actual rejection belongs to the claim
    // validator (lands in phase 5).
    const parts = decodeUnverified(token);
    if (spec.kind === 'wrong-kid') {
      expect(parts.header.kid).not.toBe(srcInputs.kid);
    }
    if (spec.kind === 'missing-required-claim') {
      const claim = (spec as unknown as { claim?: string }).claim;
      expect(claim).toBeDefined();
      expect(Object.hasOwn(parts.payload, claim as string)).toBe(false);
    }
    if (spec.kind === 'expired') {
      const exp = parts.payload.exp as number;
      expect(exp).toBeLessThan(Date.now() / 1000);
    }
    if (spec.kind === 'nbf-in-future') {
      const nbf = parts.payload.nbf as number;
      expect(nbf).toBeGreaterThan(Date.now() / 1000);
    }

    // Finding #4: for claim-only tampers the generator writes
    // canonical_header.bin / canonical_payload.bin describing what it
    // canonicalized the mutated claims to. The core MUST agree on those
    // bytes — otherwise a cross-canonicalizer drift (e.g., key-ordering,
    // number-normalization, whitespace) would go undetected on the claim-
    // mutation branch. Bitflip vectors are excluded because their canonical
    // bytes are intentionally corrupt.
    const expectedHeaderBytes = new Uint8Array(readFileSync(join(dir, 'canonical_header.bin')));
    const expectedPayloadBytes = new Uint8Array(readFileSync(join(dir, 'canonical_payload.bin')));
    const actualHeaderBytes = canonicalize(parts.header);
    const actualPayloadBytes = canonicalize(parts.payload);
    expect(bytesEqual(actualHeaderBytes, expectedHeaderBytes)).toBe(true);
    expect(bytesEqual(actualPayloadBytes, expectedPayloadBytes)).toBe(true);
  });
});
