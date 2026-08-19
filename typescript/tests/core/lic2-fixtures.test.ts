/**
 * LIC2 committed vectors — TypeScript side.
 *
 * The Go port asserts the same files in licensing/interop/lic2_fixtures_test.go.
 * Both ports re-encode from the recorded inputs and byte-compare, so a
 * change to either implementation's LIC2 output fails in both places rather
 * than silently diverging.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519Backend } from '../../src/index.ts';
import { lic2Codec } from '../../src/lic2.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures');
const LIC2_DIR = join(FIXTURES, 'tokens-lic2');
const KEYS_DIR = join(FIXTURES, 'keys');

interface LIC2Inputs {
  format: string;
  alg: string;
  kid: string;
  key_ref: string;
  payload: Record<string, unknown>;
}

function listVectors(): string[] {
  return readdirSync(LIC2_DIR)
    .filter((e) => /^[0-9]{3}/.test(e))
    .sort();
}

function loadVector(id: string) {
  const dir = join(LIC2_DIR, id);
  const inputs: LIC2Inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  const expectedToken = readFileSync(join(dir, 'expected_token.txt'), 'utf8').replace(/\n$/, '');
  return { inputs, expectedToken };
}

async function privateKeyFor(keyRef: string) {
  const base = join(KEYS_DIR, keyRef);
  return ed25519Backend.importPrivate({
    privatePem: readFileSync(join(base, 'private.pem'), 'utf8'),
    publicPem: readFileSync(join(base, 'public.pem'), 'utf8'),
  });
}

async function publicKeyFor(keyRef: string) {
  const base = join(KEYS_DIR, keyRef);
  return ed25519Backend.importPublic({
    privatePem: null,
    publicPem: readFileSync(join(base, 'public.pem'), 'utf8'),
  } as never);
}

const vectors = listVectors();

it('the LIC2 corpus is not empty', () => {
  expect(vectors.length).toBeGreaterThan(0);
});

describe.each(vectors)('LIC2 vector %s', (id) => {
  it('re-encodes to the committed bytes exactly', async () => {
    const { inputs, expectedToken } = loadVector(id);
    const priv = await privateKeyFor(inputs.key_ref);
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: inputs.kid,
      payload: inputs.payload,
      privateKey: priv,
      backend: ed25519Backend,
    });
    expect(token).toBe(expectedToken);
  });

  it('decodes and verifies with the recorded key', async () => {
    const { inputs, expectedToken } = loadVector(id);
    const env = lic2Codec.decode(expectedToken);
    expect(env.header.kid).toBe(inputs.kid);
    expect(env.header.alg).toBe('ed25519');

    const pub = await publicKeyFor(inputs.key_ref);
    expect(await ed25519Backend.verify(pub, env.signingInput, env.signature)).toBe(true);
  });

  it('surfaces every recorded claim', async () => {
    const { inputs, expectedToken } = loadVector(id);
    const env = lic2Codec.decode(expectedToken);
    for (const [k, want] of Object.entries(inputs.payload)) {
      expect(k in env.payload).toBe(true);
      expect(env.payload[k]).toEqual(want as never);
    }
  });
});
