/**
 * LIC2 conformance against an independent PASETO implementation.
 *
 * The LIC2 codec implements v4.public directly on the runtime-backed
 * ed25519 backend rather than pulling a third-party curve library into a
 * package that has zero runtime dependencies (see crypto/ed25519.ts: "no
 * third-party curve library is pulled in; auditors only need to trust the
 * runtime").
 *
 * Owning the implementation means owning the correctness proof, so this
 * suite checks our PAE and our tokens against `paseto-ts` — a separate
 * implementation by a different author, present only as a devDependency.
 * If our construction drifts from the spec, an outside implementation
 * stops accepting our tokens and these tests fail.
 */

import { describe, expect, it } from 'bun:test';

import { sign as pasetoSign, verify as pasetoVerify } from 'paseto-ts/v4';

import { ed25519Backend } from '../../src/index.ts';
import { LIC2_PREFIX, lic2Codec, pae } from '../../src/lic2.ts';

const TEXT = new TextEncoder();

async function ed25519Keys() {
  const kp = await ed25519Backend.generate('');
  return {
    priv: await ed25519Backend.importPrivate(kp.raw),
    raw: kp.raw,
    pem: kp.pem,
  };
}

// PAE vectors from the PASETO specification (Common.md). paseto-ts exposes
// a PAE helper, but importing `paseto-ts/lib/pae` trips a circular
// module-initialisation bug in that package under Bun ("Cannot access
// 'encoder' before initialization"), so the spec's own published vectors
// are used directly. PAE is additionally covered end-to-end below: a wrong
// PAE makes an independent verifier reject our tokens.
describe('PAE matches the specification vectors', () => {
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

  it('empty piece list', () => {
    expect(hex(pae([]))).toBe('0000000000000000');
  });

  it('one empty piece', () => {
    expect(hex(pae([new Uint8Array(0)]))).toBe('01000000000000000000000000000000');
  });

  it('one "test" piece', () => {
    expect(hex(pae([TEXT.encode('test')]))).toBe(
      `01000000000000000400000000000000${Buffer.from('test').toString('hex')}`,
    );
  });

  it('two pieces are unambiguous', () => {
    // The length prefixes are what prevent shifting bytes between pieces:
    // ["a","bb"] and ["ab","b"] must not collide.
    const a = hex(pae([TEXT.encode('a'), TEXT.encode('bb')]));
    const b = hex(pae([TEXT.encode('ab'), TEXT.encode('b')]));
    expect(a).not.toBe(b);
  });

  it('clears the most significant bit of each LE64 length', () => {
    // Spec: "the most significant bit MUST be cleared". Byte 7 of every
    // length prefix therefore has its high bit unset.
    const out = pae([new Uint8Array(300).fill(7)]);
    expect((out[7] ?? 0) & 0x80).toBe(0);
    expect((out[15] ?? 0) & 0x80).toBe(0);
    // 300 = 0x012c, little-endian across the first two octets.
    expect(out[8]).toBe(0x2c);
    expect(out[9]).toBe(0x01);
  });
});

describe('LIC2 tokens are accepted by an independent PASETO verifier', () => {
  it('paseto-ts verifies a token our codec produced', async () => {
    const { priv, raw } = await ed25519Keys();
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'conformance-kid',
      // No `exp` here: paseto-ts enforces PASETO's registered-claim
      // semantics, where `exp` must be an ISO-8601 string. LIC1 and LIC2
      // carry numeric Unix-second claims, and the licensing layer — not
      // the codec — owns their validation. This test is about the envelope.
      payload: { license_id: 'lic-1', scope: 'example.app' },
      privateKey: priv,
      backend: ed25519Backend,
    });

    expect(token.startsWith(LIC2_PREFIX)).toBe(true);

    // paseto-ts wants a PASERK-style key string: "k4.public." + b64url(pk).
    const publicRaw = raw.publicRaw;
    if (publicRaw === null) throw new Error('missing public raw key');
    const pk = `k4.public.${Buffer.from(publicRaw).toString('base64url')}`;

    const result = await pasetoVerify(pk, token, { validatePayload: false });
    expect(result.payload.license_id).toBe('lic-1');
    expect(result.footer).toBeDefined();
  });

  it('our codec decodes a token paseto-ts produced', async () => {
    const { raw } = await ed25519Keys();
    const privateRaw = raw.privateRaw;
    const publicRaw = raw.publicRaw;
    if (privateRaw === null || publicRaw === null) throw new Error('missing raw key');

    // PASERK secret keys are seed||public (64 bytes).
    const secret = new Uint8Array(64);
    secret.set(privateRaw.subarray(0, 32), 0);
    secret.set(publicRaw, 32);
    const sk = `k4.secret.${Buffer.from(secret).toString('base64url')}`;

    const token = await pasetoSign(
      sk,
      { license_id: 'from-paseto-ts' },
      { footer: { kid: 'their-kid' }, addExp: false, addIat: false },
    );

    const env = lic2Codec.decode(token);
    expect(env.header.kid).toBe('their-kid');
    expect(env.header.alg).toBe('ed25519');
    expect(env.payload.license_id).toBe('from-paseto-ts');
    expect(env.signature.length).toBe(64);
  });

  it('a signature over our signing input verifies with the runtime backend', async () => {
    const { priv, raw } = await ed25519Keys();
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'k',
      payload: { a: 1 },
      privateKey: priv,
      backend: ed25519Backend,
    });
    const env = lic2Codec.decode(token);
    const pub = await ed25519Backend.importPublic(raw);
    expect(await ed25519Backend.verify(pub, env.signingInput, env.signature)).toBe(true);
  });
});

describe('LIC2 rejects what it must', () => {
  it('refuses a non-ed25519 algorithm at encode time', async () => {
    const { priv } = await ed25519Keys();
    await expect(
      lic2Codec.encode({
        alg: 'rs256-pss',
        kid: 'k',
        payload: {},
        privateKey: priv,
        backend: ed25519Backend,
      }),
    ).rejects.toThrow(/ed25519 only/);
  });

  it('rejects a token with no footer, since kid would be unresolvable', async () => {
    const { raw } = await ed25519Keys();
    const privateRaw = raw.privateRaw;
    const publicRaw = raw.publicRaw;
    if (privateRaw === null || publicRaw === null) throw new Error('missing raw key');
    const secret = new Uint8Array(64);
    secret.set(privateRaw.subarray(0, 32), 0);
    secret.set(publicRaw, 32);
    const sk = `k4.secret.${Buffer.from(secret).toString('base64url')}`;

    const token = await pasetoSign(sk, { a: 1 }, { addExp: false, addIat: false });
    expect(() => lic2Codec.decode(token)).toThrow(/footer/);
  });

  it('rejects a payload too short to hold a signature', () => {
    expect(() => lic2Codec.decode(`${LIC2_PREFIX}AAAA.eyJraWQiOiJrIn0`)).toThrow(/too short/);
  });
});
