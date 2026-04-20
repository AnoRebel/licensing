/**
 * End-to-end key hierarchy integration test with the real Ed25519 backend.
 *
 * Covers:
 *   - "Generation refuses empty passphrase"
 *   - "Stored PEM is encrypted"
 *   - "Rotation preserves outstanding tokens" (retiring key still verifies)
 *   - "New tokens use new key" (active is the freshly-issued one)
 *   - Root attestation round-trip under a real signature backend
 *
 * Unit coverage for `InMemoryKeyStore` / `KeyHierarchy` orchestration lives
 * in `./key-hierarchy.test.ts` with a stub backend; this file stresses the
 * integration boundary against the real ed25519 backend.
 */

import { describe, expect, it } from 'bun:test';
import {
  AlgorithmRegistry,
  createAdvancingClock,
  decodeUnverified,
  ed25519Backend,
  encode,
  InMemoryKeyStore,
  KeyAlgBindings,
  KeyHierarchy,
  type KeyRecord,
  LicensingError,
  verify,
} from '../../src/index.ts';

function mkHierarchy() {
  const store = new InMemoryKeyStore();
  const backends = new Map([['ed25519' as const, ed25519Backend]]);
  const clock = createAdvancingClock('2026-04-12T10:00:00.000Z', 10);
  return { hierarchy: new KeyHierarchy({ store, backends, clock }), store };
}

describe('ed25519 key hierarchy — generation & storage', () => {
  it('refuses empty passphrase on root generation', async () => {
    const { hierarchy } = mkHierarchy();
    await expect(
      hierarchy.generateRoot({ scope_id: null, alg: 'ed25519', passphrase: '' }),
    ).rejects.toMatchObject({ code: 'MissingKeyPassphrase' });
  });

  it('refuses empty passphrase on signing issuance', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await expect(
      hierarchy.issueSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: root.kid,
        rootPassphrase: 'rp',
        signingPassphrase: '',
      }),
    ).rejects.toMatchObject({ code: 'MissingKeyPassphrase' });
  });

  it('stores private material only as ENCRYPTED PKCS#8 (never plaintext)', async () => {
    const { hierarchy, store } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rootpw',
    });
    const signing = await hierarchy.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rootpw',
      signingPassphrase: 'signpw',
    });

    const rootFromStore = await store.findByKid(root.kid);
    const signFromStore = await store.findByKid(signing.kid);

    expect(rootFromStore?.private_pem_enc).toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(signFromStore?.private_pem_enc).toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    // No plaintext PEM armor anywhere in the stored record.
    expect(rootFromStore?.private_pem_enc).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(signFromStore?.private_pem_enc).not.toContain('-----BEGIN PRIVATE KEY-----');
    // Public PEM is fine in the clear.
    expect(rootFromStore?.public_pem).toContain('-----BEGIN PUBLIC KEY-----');
  });
});

describe('ed25519 root attestation', () => {
  it('verifies a freshly-issued signing key against its root', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const signing = await hierarchy.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp',
    });
    expect(await hierarchy.verifyAttestation(signing.kid)).toBe(true);
  });

  it('returns false for a root kid that does not exist', async () => {
    const { hierarchy } = mkHierarchy();
    expect(await hierarchy.verifyAttestation('no-such-signing-kid')).toBe(false);
  });

  it('returns false when verifyAttestation is called on a root key itself', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    expect(await hierarchy.verifyAttestation(root.kid)).toBe(false);
  });
});

describe('ed25519 rotation — outstanding token still verifies', () => {
  // Set up a scope with an active signing key, sign a LIC1 token against it,
  // then rotate. The previous (now `retiring`) key MUST still verify the
  // outstanding token — rotation must preserve outstanding tokens.
  async function signSample(
    kid: string,
    privHandle: Awaited<ReturnType<typeof ed25519Backend.importPrivate>>,
  ) {
    const payload = {
      sub: 'license:abc',
      iat: '2026-04-12T10:00:00.000000Z',
      exp: '2027-04-12T10:00:00.000000Z',
    };
    return encode({
      header: { v: 1, typ: 'lic', alg: 'ed25519', kid },
      payload,
      privateKey: privHandle,
      backend: ed25519Backend,
    });
  }

  it('the retiring key still verifies its outstanding token; the new active signs fresh tokens', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const firstSigning = await hierarchy.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp1',
    });

    // Sign a token against the first signing key.
    const { handle: firstHandle } = await hierarchy.importSigningPrivate(firstSigning.kid, 'sp1');
    const outstandingToken = await signSample(firstSigning.kid, firstHandle);

    // Rotate.
    const { outgoing, incoming } = await hierarchy.rotateSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp2',
    });
    expect(outgoing.id).toBe(firstSigning.id);
    expect(outgoing.state).toBe('retiring');
    expect(incoming.state).toBe('active');
    expect(incoming.rotated_from).toBe(firstSigning.id);

    // Rebuild a verifier that can still resolve the retiring kid.
    const registry = new AlgorithmRegistry();
    registry.register(ed25519Backend);
    const bindings = new KeyAlgBindings();
    bindings.bind(firstSigning.kid, 'ed25519');
    bindings.bind(incoming.kid, 'ed25519');

    const retiringRec = await hierarchy.findByKid(firstSigning.kid);
    const incomingRec = await hierarchy.findByKid(incoming.kid);
    // verify() only inspects `alg` + `publicPem` paths, but the KeyRecord
    // contract requires all fields. We populate `raw.publicRaw` with an
    // empty buffer — importPublic picks up the PEM, not the raw slot.
    const emptyRaw = { privateRaw: null, publicRaw: new Uint8Array(0) };
    const keys = new Map<string, KeyRecord>([
      [
        firstSigning.kid,
        {
          kid: firstSigning.kid,
          alg: 'ed25519',
          privatePem: null,
          publicPem: retiringRec?.public_pem ?? '',
          raw: emptyRaw,
        },
      ],
      [
        incoming.kid,
        {
          kid: incoming.kid,
          alg: 'ed25519',
          privatePem: null,
          publicPem: incomingRec?.public_pem ?? '',
          raw: emptyRaw,
        },
      ],
    ]);

    // The outstanding token signed by the (now retiring) key still verifies.
    const decoded = decodeUnverified(outstandingToken);
    expect(decoded.header.kid).toBe(firstSigning.kid);
    const resOutstanding = await verify(outstandingToken, { registry, bindings, keys });
    expect(resOutstanding.header.kid).toBe(firstSigning.kid);

    // A fresh token signed with the new active key also verifies.
    const { handle: secondHandle } = await hierarchy.importSigningPrivate(incoming.kid, 'sp2');
    const freshToken = await signSample(incoming.kid, secondHandle);
    const resFresh = await verify(freshToken, { registry, bindings, keys });
    expect(resFresh.header.kid).toBe(incoming.kid);

    // Exactly one active + one retiring remain.
    const actives = await hierarchy.list({ role: 'signing', state: 'active' });
    const retiring = await hierarchy.list({ role: 'signing', state: 'retiring' });
    expect(actives.length).toBe(1);
    expect(retiring.length).toBe(1);
  });
});

describe('ed25519 importSigningPrivate — passphrase handling', () => {
  it('returns a handle that can sign (functional check)', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const signing = await hierarchy.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp',
    });
    const { handle } = await hierarchy.importSigningPrivate(signing.kid, 'sp');
    const msg = new TextEncoder().encode('hello');
    const sig = await ed25519Backend.sign(handle, msg);
    expect(sig.length).toBe(64);

    const pub = await ed25519Backend.importPublic({
      privatePem: null,
      publicPem: signing.public_pem,
    });
    expect(await ed25519Backend.verify(pub, msg, sig)).toBe(true);
  });

  it('wrong passphrase surfaces KeyDecryptionFailed', async () => {
    const { hierarchy } = mkHierarchy();
    const root = await hierarchy.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const signing = await hierarchy.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'right',
    });
    await expect(hierarchy.importSigningPrivate(signing.kid, 'wrong')).rejects.toMatchObject({
      code: 'KeyDecryptionFailed',
    });
  });
});

describe('ed25519 LicensingError conformance', () => {
  it('all hierarchy errors descend from LicensingError (code-discriminated)', async () => {
    const { hierarchy } = mkHierarchy();
    try {
      await hierarchy.generateRoot({ scope_id: null, alg: 'ed25519', passphrase: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LicensingError);
      expect((e as LicensingError).code).toBe('MissingKeyPassphrase');
    }
  });
});
