import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AlgorithmRegistry, RSA_MIN_BITS, rsaPssBackend } from '../../src/index.ts';

const FIXTURE_DIR = join(import.meta.dir, '../../../fixtures/keys/rsa');

function readFixturePem(): { privatePem: string; publicPem: string } {
  return {
    privatePem: readFileSync(join(FIXTURE_DIR, 'private.pem'), 'utf8'),
    publicPem: readFileSync(join(FIXTURE_DIR, 'public.pem'), 'utf8'),
  };
}

describe('rsa-pss backend — basic contract', () => {
  it('advertises alg = "rs256-pss"', () => {
    expect(rsaPssBackend.alg).toBe('rs256-pss');
  });

  it('registers into AlgorithmRegistry exactly once', () => {
    const reg = new AlgorithmRegistry();
    reg.register(rsaPssBackend);
    expect(() => reg.register(rsaPssBackend)).toThrow();
  });
});

describe('rsa-pss backend — PEM round-trip', () => {
  it('signs and verifies with fixture PEMs', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const priv = await rsaPssBackend.importPrivate({ privatePem, publicPem });
    const pub = await rsaPssBackend.importPublic({ privatePem: null, publicPem });
    const data = new TextEncoder().encode('rsa-pss-round-trip');
    const sig = await rsaPssBackend.sign(priv, data);
    expect(sig).toBeInstanceOf(Uint8Array);
    // RSA-3072 produces a 384-byte signature.
    expect(sig.length).toBe(384);
    expect(await rsaPssBackend.verify(pub, data, sig)).toBe(true);
  });

  it('PSS signatures are non-deterministic (fresh salt each call)', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const priv = await rsaPssBackend.importPrivate({ privatePem, publicPem });
    const data = new TextEncoder().encode('same-message');
    const sig1 = await rsaPssBackend.sign(priv, data);
    const sig2 = await rsaPssBackend.sign(priv, data);
    // Two PSS signatures over the same message MUST differ — the 32-byte
    // salt is fresh per-sign.
    expect(sig1).not.toEqual(sig2);
  });

  it('rejects a tampered signature', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const priv = await rsaPssBackend.importPrivate({ privatePem, publicPem });
    const pub = await rsaPssBackend.importPublic({ privatePem: null, publicPem });
    const data = new TextEncoder().encode('rsa-pss-round-trip');
    const sig = await rsaPssBackend.sign(priv, data);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    expect(await rsaPssBackend.verify(pub, data, sig)).toBe(false);
  });
});

describe('rsa-pss backend — minimum-strength enforcement', () => {
  it('rejects a 1024-bit key', async () => {
    // Generate a too-small key directly with node:crypto, bypassing the
    // backend's generate(). We confirm that import() refuses it.
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await expect(rsaPssBackend.importPrivate({ privatePem, publicPem })).rejects.toThrow();
    await expect(rsaPssBackend.importPublic({ privatePem: null, publicPem })).rejects.toThrow();
  });

  it('generate() produces a key at or above the minimum', async () => {
    const { pem } = await rsaPssBackend.generate('unused');
    const priv = await rsaPssBackend.importPrivate(pem);
    // Round-trip just to prove the handle is usable. The minimum-strength
    // check inside importPrivate would have thrown if generate undershot.
    const data = new Uint8Array([1, 2, 3, 4]);
    const sig = await rsaPssBackend.sign(priv, data);
    expect(sig.length).toBeGreaterThanOrEqual(RSA_MIN_BITS / 8);
  });
});

describe('rsa-pss backend — raw DER round-trip', () => {
  it('generate → raw DER → import → sign/verify', async () => {
    const { raw } = await rsaPssBackend.generate('unused');
    expect(raw.privateRaw).not.toBeNull();
    expect(raw.privateRaw?.length).toBeGreaterThan(0);
    expect(raw.publicRaw.length).toBeGreaterThan(0);
    const priv = await rsaPssBackend.importPrivate(raw);
    const pub = await rsaPssBackend.importPublic(raw);
    const data = new TextEncoder().encode('rsa-raw-round-trip');
    const sig = await rsaPssBackend.sign(priv, data);
    expect(await rsaPssBackend.verify(pub, data, sig)).toBe(true);
  });
});
