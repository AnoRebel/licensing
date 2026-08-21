/**
 * LIC2 carries the same domain claims as LIC1.
 *
 * The two formats differ in envelope only. A verified LIC2 token must
 * surface exactly the claims a verified LIC1 token would for the same
 * licence and seat — otherwise callers would have to branch on format,
 * which defeats the point of a codec router.
 */

import { describe, expect, it } from 'bun:test';

import { ed25519Backend, encode as lic1Encode, lic2Codec } from '../../src/index.ts';
import { decodeUnverified } from '../../src/lic1.ts';

const CLAIMS = {
  jti: 'jti-parity-1',
  iat: 1700000000,
  nbf: 1700000000,
  exp: 1702592000,
  force_online_after: null,
  scope: 'example.app',
  license_id: '01923456-0000-7000-8000-000000000001',
  usage_id: '01923456-0000-7000-8000-000000000002',
  usage_fingerprint: 'a'.repeat(64),
  status: 'active',
  max_usages: 3,
} as const;

async function keys() {
  const kp = await ed25519Backend.generate('');
  return {
    priv: await ed25519Backend.importPrivate(kp.raw),
    pub: await ed25519Backend.importPublic(kp.raw),
  };
}

describe('LIC1 and LIC2 surface identical claims', () => {
  it('the decoded payloads match key for key', async () => {
    const { priv } = await keys();

    const lic1 = await lic1Encode({
      header: { v: 1, typ: 'lic', alg: 'ed25519', kid: 'parity-kid' },
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });
    const lic2 = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'parity-kid',
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });

    const a = decodeUnverified(lic1);
    const b = decodeUnverified(lic2);

    expect(Object.keys(b.payload).sort()).toEqual(Object.keys(a.payload).sort());
    expect(b.payload).toEqual(a.payload);
  });

  it('both surface the same kid and alg through the envelope', async () => {
    const { priv } = await keys();
    const lic1 = await lic1Encode({
      header: { v: 1, typ: 'lic', alg: 'ed25519', kid: 'same-kid' },
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });
    const lic2 = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'same-kid',
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });

    // Compare the fields the common envelope guarantees. LIC1 additionally
    // exposes `v` and `typ`, which are LIC1-envelope details with no
    // PASETO equivalent: v4.public commits to its version and algorithm in
    // the prefix itself, so there is no header field to carry them.
    const a = decodeUnverified(lic1).header;
    const b = decodeUnverified(lic2).header;
    expect({ alg: a.alg, kid: a.kid }).toEqual({ alg: b.alg, kid: b.kid });
  });

  it('a null claim survives the LIC2 envelope', async () => {
    // force_online_after is nullable and null is not the same as absent —
    // the spec treats them identically at verification, but the claim must
    // still round-trip rather than being dropped by the encoder.
    const { priv } = await keys();
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'k',
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });
    const env = decodeUnverified(token);
    expect('force_online_after' in env.payload).toBe(true);
    expect(env.payload.force_online_after).toBeNull();
  });

  it('a LIC2 token verifies under the runtime backend', async () => {
    const { priv, pub } = await keys();
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'k',
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });
    const env = decodeUnverified(token);
    expect(await ed25519Backend.verify(pub, env.signingInput, env.signature)).toBe(true);
  });

  it('a tampered LIC2 payload fails verification', async () => {
    const { priv, pub } = await keys();
    const token = await lic2Codec.encode({
      alg: 'ed25519',
      kid: 'k',
      payload: CLAIMS,
      privateKey: priv,
      backend: ed25519Backend,
    });
    const env = decodeUnverified(token);
    const tampered = new Uint8Array(env.signingInput);
    tampered[tampered.length - 1] ^= 0xff;
    expect(await ed25519Backend.verify(pub, tampered, env.signature)).toBe(false);
  });
});
