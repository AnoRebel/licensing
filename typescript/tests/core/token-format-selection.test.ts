/**
 * tokenFormat selection at issuance.
 *
 * The guarantees under test: LIC1 is what you get unless you ask for
 * something else, a verifier accepts both formats no matter what the issuer
 * was configured to emit, and an unsupported (format, alg) pairing fails
 * before a token exists rather than producing one that cannot be verified.
 */

import { describe, expect, it } from 'bun:test';

import {
  AlgorithmRegistry,
  createAdvancingClock,
  createLicense,
  ed25519Backend,
  generateRootKey,
  hmacBackend,
  issueInitialSigningKey,
  issueToken,
  type KeyAlg,
  KeyAlgBindings,
  type KeyRecord,
  registerUsage,
  type SignatureBackend,
  verify,
} from '../../src/index.ts';
import { LIC1_PREFIX, lic1Codec } from '../../src/lic1.ts';
import { LIC2_PREFIX, lic2Codec } from '../../src/lic2.ts';
import { MemoryStorage } from '../../src/storage/memory/index.ts';

const FP = 'a'.repeat(64);

async function harness(alg: KeyAlg = 'ed25519') {
  const clock = createAdvancingClock('2026-04-19T10:00:00.000000Z');
  const storage = new MemoryStorage({ clock });
  const backends = new Map<KeyAlg, SignatureBackend>([
    ['ed25519', ed25519Backend],
    ['hs256', hmacBackend],
  ]);
  const root = await generateRootKey(storage, clock, backends, {
    scope_id: null,
    alg,
    passphrase: 'root-pw',
  });
  const signing = await issueInitialSigningKey(storage, clock, backends, {
    scope_id: null,
    alg,
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });
  const license = await createLicense(storage, clock, {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'u-1',
    max_usages: 3,
    expires_at: '2027-04-19T10:00:00.000000Z',
    grace_until: null,
  });
  const { license: active, usage } = await registerUsage(storage, clock, {
    license_id: license.id,
    fingerprint: FP,
  });
  return { storage, clock, backends, signing, license: active, usage, alg };
}

async function verifierFor(h: Awaited<ReturnType<typeof harness>>) {
  const stored = await h.storage.getKeyByKid(h.signing.kid);
  if (!stored) throw new Error('signing key vanished');
  const registry = new AlgorithmRegistry();
  registry.register(h.alg === 'ed25519' ? ed25519Backend : hmacBackend);
  const bindings = new KeyAlgBindings();
  bindings.bind(h.signing.kid, h.alg);
  const record: KeyRecord = {
    kid: stored.kid,
    alg: stored.alg,
    publicPem: stored.public_pem,
    privatePem: null,
    raw: { publicRaw: null as unknown as Uint8Array, privateRaw: null },
  };
  return { registry, bindings, keys: new Map([[h.signing.kid, record]]) };
}

describe('tokenFormat defaults to LIC1', () => {
  it('omitting tokenFormat produces a LIC1 token', async () => {
    const h = await harness();
    const { token } = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
    });
    expect(token.startsWith(LIC1_PREFIX)).toBe(true);
    expect(token.startsWith(LIC2_PREFIX)).toBe(false);
  });

  it('explicit LIC1 produces the same prefix', async () => {
    const h = await harness();
    const { token } = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC1',
    });
    expect(token.startsWith(LIC1_PREFIX)).toBe(true);
  });

  it('LIC2 is opt-in and produces a PASETO-prefixed token', async () => {
    const h = await harness();
    const { token } = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC2',
    });
    expect(token.startsWith(LIC2_PREFIX)).toBe(true);
  });
});

describe('a verifier accepts both formats', () => {
  it('verifies a LIC1 and a LIC2 token with the same key material', async () => {
    const h = await harness();
    const opts = await verifierFor(h);

    const lic1 = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC1',
    });
    const lic2 = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC2',
    });

    const a = await verify(lic1.token, opts);
    const b = await verify(lic2.token, opts);

    expect(a.payload.license_id).toBe(h.license.id);
    expect(b.payload.license_id).toBe(h.license.id);
    expect(b.payload.usage_fingerprint).toBe(a.payload.usage_fingerprint);
    expect(b.header.kid).toBe(a.header.kid);
  });
});

describe('unsupported (format, alg) pairings fail before a token exists', () => {
  // hs256 cannot reach issueToken: the key hierarchy refuses symmetric
  // algorithms as a root, so an hs256 signing key cannot be created in the
  // first place. The (format, alg) guard is therefore exercised at the
  // codec, which is where it is enforced.
  it('the LIC2 codec refuses a non-ed25519 algorithm', async () => {
    const kp = await ed25519Backend.generate('');
    const priv = await ed25519Backend.importPrivate(kp.raw);
    await expect(
      lic2Codec.encode({
        alg: 'hs256',
        kid: 'k',
        payload: { a: 1 },
        privateKey: priv,
        backend: hmacBackend,
      }),
    ).rejects.toThrow(/ed25519 only/);
  });

  it('LIC2 declares ed25519 as its only supported algorithm', () => {
    expect([...lic2Codec.supportedAlgs]).toEqual(['ed25519']);
  });

  it('LIC1 accepts the algorithms LIC2 does not', () => {
    expect(lic1Codec.supportedAlgs.has('hs256')).toBe(true);
    expect(lic1Codec.supportedAlgs.has('rs256-pss')).toBe(true);
    expect(lic2Codec.supportedAlgs.has('hs256')).toBe(false);
    expect(lic2Codec.supportedAlgs.has('rs256-pss')).toBe(false);
  });
});

describe('a tampered LIC2 token is rejected and surfaces no claims', () => {
  it('flipping a payload byte fails verification', async () => {
    const h = await harness();
    const opts = await verifierFor(h);
    const { token } = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC2',
    });

    // Rewrite one base64 character of the payload segment.
    const body = token.slice(LIC2_PREFIX.length);
    const [payloadB64, footerB64] = body.split('.') as [string, string];
    const flipped = (payloadB64[0] === 'A' ? 'B' : 'A') + payloadB64.slice(1);
    const tampered = `${LIC2_PREFIX}${flipped}.${footerB64}`;

    await expect(verify(tampered, opts)).rejects.toThrow();
  });

  it('swapping the footer kid fails verification', async () => {
    const h = await harness();
    const opts = await verifierFor(h);
    const { token } = await issueToken(h.storage, h.clock, h.backends, {
      license: h.license,
      usage: h.usage,
      ttlSeconds: 3600,
      alg: 'ed25519',
      signingPassphrase: 'sign-pw',
      tokenFormat: 'LIC2',
    });

    // The footer is authenticated (it is fed into PAE), so rewriting it
    // must invalidate the signature rather than merely redirecting the key
    // lookup.
    const body = token.slice(LIC2_PREFIX.length);
    const [payloadB64] = body.split('.') as [string, string];
    const forgedFooter = Buffer.from(JSON.stringify({ kid: 'attacker-kid' })).toString('base64url');
    const tampered = `${LIC2_PREFIX}${payloadB64}.${forgedFooter}`;

    await expect(verify(tampered, opts)).rejects.toThrow();
  });
});
