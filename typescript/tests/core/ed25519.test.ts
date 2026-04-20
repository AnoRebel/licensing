import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AlgorithmRegistry,
  decodeUnverified,
  ED25519_RAW_KEY_LEN,
  ED25519_SIG_LEN,
  ed25519Backend,
  encode,
  KeyAlgBindings,
  verify,
} from '../../src/index.ts';

const FIXTURE_DIR = join(import.meta.dir, '../../../fixtures/keys/ed25519');

function readFixturePem(): { privatePem: string; publicPem: string } {
  return {
    privatePem: readFileSync(join(FIXTURE_DIR, 'private.pem'), 'utf8'),
    publicPem: readFileSync(join(FIXTURE_DIR, 'public.pem'), 'utf8'),
  };
}

describe('ed25519 backend — basic contract', () => {
  it('advertises alg = "ed25519"', () => {
    expect(ed25519Backend.alg).toBe('ed25519');
  });

  it('registers into AlgorithmRegistry exactly once', () => {
    const reg = new AlgorithmRegistry();
    reg.register(ed25519Backend);
    expect(() => reg.register(ed25519Backend)).toThrow();
    expect(reg.get('ed25519')).toBe(ed25519Backend);
  });
});

describe('ed25519 backend — PEM import / sign / verify', () => {
  it('signs and verifies a round-trip with fixture PEMs', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const privHandle = await ed25519Backend.importPrivate({ privatePem, publicPem });
    const pubHandle = await ed25519Backend.importPublic({ privatePem: null, publicPem });
    const data = new TextEncoder().encode('hello licensing');
    const sig = await ed25519Backend.sign(privHandle, data);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(ED25519_SIG_LEN);
    expect(await ed25519Backend.verify(pubHandle, data, sig)).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const priv = await ed25519Backend.importPrivate({ privatePem, publicPem });
    const pub = await ed25519Backend.importPublic({ privatePem: null, publicPem });
    const data = new TextEncoder().encode('hello licensing');
    const sig = await ed25519Backend.sign(priv, data);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    expect(await ed25519Backend.verify(pub, data, sig)).toBe(false);
  });

  it('rejects a wrong-length signature without throwing', async () => {
    const { publicPem } = readFixturePem();
    const pub = await ed25519Backend.importPublic({ privatePem: null, publicPem });
    expect(await ed25519Backend.verify(pub, new Uint8Array([0]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    );
  });
});

describe('ed25519 backend — raw-bytes round-trip', () => {
  it('generate → raw → importPrivate/Public → sign/verify round-trip', async () => {
    const { raw, pem } = await ed25519Backend.generate('unused-in-this-layer');
    expect(raw.privateRaw).not.toBeNull();
    expect(raw.privateRaw?.length).toBe(ED25519_RAW_KEY_LEN);
    expect(raw.publicRaw.length).toBe(ED25519_RAW_KEY_LEN);
    expect(pem.privatePem).toContain('BEGIN PRIVATE KEY');
    expect(pem.publicPem).toContain('BEGIN PUBLIC KEY');

    // Import the private handle via RAW bytes, and the public via RAW bytes.
    const priv = await ed25519Backend.importPrivate(raw);
    const pub = await ed25519Backend.importPublic(raw);
    const data = new TextEncoder().encode('raw-round-trip');
    const sig = await ed25519Backend.sign(priv, data);
    expect(await ed25519Backend.verify(pub, data, sig)).toBe(true);
  });

  it('raw-derived public key verifies a PEM-signed message (raw↔PEM parity)', async () => {
    const { raw, pem } = await ed25519Backend.generate('unused');
    const privFromPem = await ed25519Backend.importPrivate(pem);
    const pubFromRaw = await ed25519Backend.importPublic(raw);
    const data = new TextEncoder().encode('cross-format');
    const sig = await ed25519Backend.sign(privFromPem, data);
    expect(await ed25519Backend.verify(pubFromRaw, data, sig)).toBe(true);
  });

  it('rejects a raw seed of wrong length', async () => {
    await expect(
      ed25519Backend.importPrivate({
        privateRaw: new Uint8Array(31),
        publicRaw: new Uint8Array(32),
      }),
    ).rejects.toThrow();
  });

  it('rejects a raw public key of wrong length', async () => {
    await expect(
      ed25519Backend.importPublic({
        privateRaw: null,
        publicRaw: new Uint8Array(33),
      }),
    ).rejects.toThrow();
  });
});

describe('ed25519 backend — end-to-end LIC1 encode/verify', () => {
  it('produces a LIC1 token that round-trips through core.verify()', async () => {
    const { privatePem, publicPem } = readFixturePem();
    const registry = new AlgorithmRegistry();
    registry.register(ed25519Backend);
    const bindings = new KeyAlgBindings();
    bindings.bind('test-kid', 'ed25519');

    const priv = await ed25519Backend.importPrivate({ privatePem, publicPem });
    const header = { v: 1 as const, typ: 'lic' as const, alg: 'ed25519' as const, kid: 'test-kid' };
    const payload = { sub: 'lic-abc', exp: 2_000_000_000 };
    const token = await encode({ header, payload, privateKey: priv, backend: ed25519Backend });
    expect(token.startsWith('LIC1.')).toBe(true);

    const parts = decodeUnverified(token);
    expect(parts.header).toEqual(header);
    expect(parts.payload).toEqual(payload);

    // verify() needs a KeyRecord map. Construct one from the fixture.
    const record = {
      kid: 'test-kid',
      alg: 'ed25519' as const,
      privatePem,
      publicPem,
      raw: {
        privateRaw: null,
        publicRaw: new Uint8Array(32), // unused here — verify() uses PEM path
      },
    };
    const verified = await verify(token, {
      registry,
      bindings,
      keys: new Map([[record.kid, record]]),
    });
    expect(verified.header.kid).toBe('test-kid');
  });
});
