import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AlgorithmRegistry,
  HMAC_MIN_SECRET_LEN,
  HMAC_SIG_LEN,
  hmacBackend,
} from '../../src/index.ts';

const FIXTURE_SECRET_PATH = join(import.meta.dir, '../../../fixtures/keys/hmac/secret.hex');

function readFixtureSecret(): Uint8Array {
  const hex = readFileSync(FIXTURE_SECRET_PATH, 'utf8').trim();
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

describe('hmac backend — basic contract', () => {
  it('advertises alg = "hs256"', () => {
    expect(hmacBackend.alg).toBe('hs256');
  });

  it('registers into AlgorithmRegistry exactly once', () => {
    const reg = new AlgorithmRegistry();
    reg.register(hmacBackend);
    expect(() => reg.register(hmacBackend)).toThrow();
  });
});

describe('hmac backend — sign/verify', () => {
  it('round-trips with fixture secret', async () => {
    const secret = readFixtureSecret();
    expect(secret.length).toBe(HMAC_MIN_SECRET_LEN);
    const priv = await hmacBackend.importPrivate({ privateRaw: secret, publicRaw: secret });
    const pub = await hmacBackend.importPublic({ privateRaw: null, publicRaw: secret });
    const data = new TextEncoder().encode('hmac-round-trip');
    const sig = await hmacBackend.sign(priv, data);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(HMAC_SIG_LEN);
    expect(await hmacBackend.verify(pub, data, sig)).toBe(true);
  });

  it('is deterministic (same input → same MAC)', async () => {
    const secret = readFixtureSecret();
    const k = await hmacBackend.importPrivate({ privateRaw: secret, publicRaw: secret });
    const data = new TextEncoder().encode('repeat-me');
    const a = await hmacBackend.sign(k, data);
    const b = await hmacBackend.sign(k, data);
    expect(a).toEqual(b);
  });

  it('rejects a tampered MAC', async () => {
    const secret = readFixtureSecret();
    const k = await hmacBackend.importPrivate({ privateRaw: secret, publicRaw: secret });
    const data = new TextEncoder().encode('tamper-test');
    const sig = await hmacBackend.sign(k, data);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    expect(await hmacBackend.verify(k, data, sig)).toBe(false);
  });

  it('rejects a wrong-length MAC without throwing', async () => {
    const secret = readFixtureSecret();
    const k = await hmacBackend.importPublic({ privateRaw: null, publicRaw: secret });
    expect(await hmacBackend.verify(k, new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    );
  });

  it('different secrets do NOT verify each other', async () => {
    const secret1 = readFixtureSecret();
    const secret2 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) secret2[i] = i;
    const k1 = await hmacBackend.importPrivate({ privateRaw: secret1, publicRaw: secret1 });
    const k2 = await hmacBackend.importPublic({ privateRaw: null, publicRaw: secret2 });
    const data = new TextEncoder().encode('cross-secret');
    const sig = await hmacBackend.sign(k1, data);
    expect(await hmacBackend.verify(k2, data, sig)).toBe(false);
  });
});

describe('hmac backend — minimum-strength enforcement', () => {
  it('rejects a 31-byte secret', async () => {
    await expect(
      hmacBackend.importPrivate({
        privateRaw: new Uint8Array(31),
        publicRaw: new Uint8Array(31),
      }),
    ).rejects.toThrow();
  });

  it('rejects PEM material (HMAC is raw-only)', async () => {
    await expect(
      hmacBackend.importPrivate({ privatePem: 'whatever', publicPem: 'whatever' }),
    ).rejects.toThrow();
    await expect(
      hmacBackend.importPublic({ privatePem: null, publicPem: 'whatever' }),
    ).rejects.toThrow();
  });
});

describe('hmac backend — generate()', () => {
  it('produces a ≥32-byte secret usable for sign/verify', async () => {
    const { raw } = await hmacBackend.generate('unused');
    expect(raw.privateRaw).not.toBeNull();
    expect(raw.privateRaw?.length).toBe(HMAC_MIN_SECRET_LEN);
    expect(raw.publicRaw.length).toBe(HMAC_MIN_SECRET_LEN);
    // Symmetric: privateRaw === publicRaw.
    expect(raw.privateRaw).toEqual(raw.publicRaw);
    const k = await hmacBackend.importPrivate(raw);
    const sig = await hmacBackend.sign(k, new Uint8Array([1, 2, 3]));
    expect(await hmacBackend.verify(k, new Uint8Array([1, 2, 3]), sig)).toBe(true);
  });
});
