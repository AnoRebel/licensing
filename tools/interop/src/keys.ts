/**
 * Fixture-key loader for the interop CLIs. Mirrors the shape used by the
 * fixture-generator but intentionally stands alone so the interop tools
 * don't drag the generator's build artefacts into the runtime path.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { KeyRecord, RawKeyMaterial } from '@licensing/sdk/crypto';

export type KeyAlg = 'ed25519' | 'rs256-pss' | 'hs256';
export type KeyRef = 'ed25519' | 'rsa' | 'hmac';

const here = dirname(fileURLToPath(import.meta.url));
// repo root: tools/interop/src/ → ../../..
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

const EMPTY_RAW: RawKeyMaterial = {
  privateRaw: null,
  publicRaw: new Uint8Array(0),
};

/** Read the on-disk material for a fixture key and return it as a KeyRecord
 *  ready to plug into an AlgorithmRegistry / KeyAlgBindings triple.
 *
 *  KeyRecord requires both PEM fields and a `raw` block. For HMAC the PEM
 *  fields are stubbed out (the backend only consumes `raw`), and for
 *  asymmetric algs `raw` is stubbed out (the backend prefers PEM when
 *  present via isPem()/isRaw() detection). */
const ALLOWED_REFS: ReadonlySet<KeyRef> = new Set(['ed25519', 'rsa', 'hmac']);

export function loadFixtureKey(ref: KeyRef, alg: KeyAlg, kid: string): KeyRecord {
  // Whitelist the ref so an attacker-controlled stdin value can't escape
  // the fixtures/keys/ sandbox via `../`. This harness only ever runs
  // against committed test fixtures, but defense-in-depth against future
  // reuse — the CLI surface is exactly what a malicious caller would
  // target first.
  if (!ALLOWED_REFS.has(ref)) {
    throw new Error(`invalid key_ref: ${ref}`);
  }
  const base = join(FIXTURES_DIR, 'keys', ref);
  if (alg === 'hs256') {
    const hex = readFileSync(join(base, 'secret.hex'), 'utf8').trim();
    const raw = hexToBytes(hex);
    return {
      kid,
      alg,
      privatePem: null,
      publicPem: '',
      raw: { privateRaw: raw, publicRaw: raw },
    };
  }
  const privatePem = readFileSync(join(base, 'private.pem'), 'utf8');
  const publicPem = readFileSync(join(base, 'public.pem'), 'utf8');
  return { kid, alg, privatePem, publicPem, raw: EMPTY_RAW };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
