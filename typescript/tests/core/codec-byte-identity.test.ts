/**
 * Byte-identity gate for registered codecs.
 *
 * The corpus suite next door re-derives the token string inline — it
 * base64s the canonical bytes and concatenates them itself. That checks the
 * fixture against a *copy* of the algorithm, so it keeps passing even when
 * the shipped encoder changes: appending a character to `encode()`'s return
 * value leaves all 174 of those assertions green.
 *
 * These tests drive the production `encode()` and the codec's own `encode`
 * instead, so drift in shipped code fails here.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ed25519Backend,
  encode,
  hmacBackend,
  type KeyAlg,
  type SignatureBackend,
} from '../../src/index.ts';
import { LIC1_PREFIX, lic1Codec } from '../../src/lic1.ts';
import { codecFor, registeredPrefixes } from '../../src/token-codec.ts';

const FIXTURES_ROOT = join(import.meta.dir, '../../../fixtures');
const TOKENS_DIR = join(FIXTURES_ROOT, 'tokens');
const KEYS_DIR = join(FIXTURES_ROOT, 'keys');

// Deterministic-signature algorithms only. RSA-PSS is randomised, so its
// tokens cannot be byte-compared; the corpus suite excludes it for the same
// reason.
const VECTORS = ['001-ed25519-active', '003-hs256-active', '004-ed25519-grace'];

function backendFor(alg: KeyAlg): SignatureBackend {
  if (alg === 'ed25519') return ed25519Backend;
  if (alg === 'hs256') return hmacBackend;
  throw new Error(`unexpected alg for byte-identity: ${alg}`);
}

function loadVector(id: string) {
  const dir = join(TOKENS_DIR, id);
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  const expectedToken = readFileSync(join(dir, 'expected_token.txt'), 'utf8').replace(/\n$/, '');
  return { inputs, expectedToken };
}

function loadKey(keyRef: string, alg: KeyAlg) {
  const base = join(KEYS_DIR, keyRef);
  if (alg === 'hs256') {
    const hex = readFileSync(join(base, 'secret.hex'), 'utf8').trim();
    const u8 = new Uint8Array(Buffer.from(hex, 'hex'));
    return { privateRaw: u8, publicRaw: u8 };
  }
  return {
    privatePem: readFileSync(join(base, 'private.pem'), 'utf8'),
    publicPem: readFileSync(join(base, 'public.pem'), 'utf8'),
  };
}

async function importPrivate(backend: SignatureBackend, keyRef: string, alg: KeyAlg) {
  return backend.importPrivate(loadKey(keyRef, alg) as never);
}

describe.each(VECTORS)('vector %s — shipped encoder byte-identity', (id) => {
  it('encode() reproduces the committed token exactly', async () => {
    const { inputs, expectedToken } = loadVector(id);
    const backend = backendFor(inputs.alg);
    const privateKey = await importPrivate(backend, inputs.key_ref, inputs.alg);

    const token = await encode({
      header: inputs.header,
      payload: inputs.payload,
      privateKey,
      backend,
    });

    expect(token).toBe(expectedToken);
  });

  it('the registered LIC1 codec reproduces the committed token exactly', async () => {
    const { inputs, expectedToken } = loadVector(id);
    const backend = backendFor(inputs.alg);
    const privateKey = await importPrivate(backend, inputs.key_ref, inputs.alg);

    const token = await lic1Codec.encode({
      alg: inputs.alg,
      kid: inputs.kid,
      payload: inputs.payload,
      privateKey,
      backend,
    });

    expect(token).toBe(expectedToken);
  });

  it('routes to the LIC1 codec and round-trips its own output', async () => {
    const { expectedToken } = loadVector(id);
    expect(codecFor(expectedToken).prefix).toBe(LIC1_PREFIX);
    const decoded = codecFor(expectedToken).decode(expectedToken);
    expect(decoded.header.kid.length).toBeGreaterThan(0);
  });
});

describe('codec registry', () => {
  it('has LIC1 registered', () => {
    expect(registeredPrefixes()).toContain(LIC1_PREFIX);
  });
});
