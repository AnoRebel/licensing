/**
 * Loader for fixtures/keys/<alg>/. Returns the raw material the three core
 * backends accept via `importPrivate` / `importPublic`. PEM keys are read as
 * text; the HMAC secret is hex-decoded into a Uint8Array.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PemKeyMaterial, RawKeyMaterial } from '@licensing/sdk/crypto';

import type { KeyAlg, KeyRef } from './types.ts';

export interface LoadedKey {
  readonly alg: KeyAlg;
  /** Shape accepted by `backend.importPrivate` / `backend.importPublic`. */
  readonly material: PemKeyMaterial | RawKeyMaterial;
}

/** Load the private-half material for the given key_ref. The fixtures dir
 *  is passed in (rather than inferred) so a caller can point at a temp
 *  directory in tests. */
export function loadKey(fixturesDir: string, ref: KeyRef, alg: KeyAlg): LoadedKey {
  const base = join(fixturesDir, 'keys', ref);
  if (alg === 'hs256') {
    const hex = readFileSync(join(base, 'secret.hex'), 'utf8').trim();
    const raw = hexToBytes(hex);
    return { alg, material: { privateRaw: raw, publicRaw: raw } };
  }
  const privatePem = readFileSync(join(base, 'private.pem'), 'utf8');
  const publicPem = readFileSync(join(base, 'public.pem'), 'utf8');
  const material: PemKeyMaterial = { privatePem, publicPem };
  return { alg, material };
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
