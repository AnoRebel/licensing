/**
 * Backend-independent unit tests for the key-hierarchy layer.
 *
 * These cover:
 *   - `InMemoryKeyStore` invariants (unique kid, filter, stable ordering, update)
 *   - `KeyHierarchy` orchestration contracts (empty-passphrase rejection,
 *     single-active-signing invariant, unknown root kid, scope/alg mismatch,
 *     rotation linkage)
 *
 * Cross-backend integration (real ed25519 attestation + verify-after-rotate)
 * lives in `crypto-ed25519/tests/key-hierarchy.integration.test.ts` where a
 * real `SignatureBackend` is already a workspace dep.
 *
 * A stub backend is injected here for paths that need *any* registered
 * backend (e.g. generateRoot). It emits deterministic keys and signs with a
 * trivial "signature = sha256(secret || msg)" so tampering tests still work
 * structurally without pulling in node:crypto-heavy backends.
 */

import { describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type {
  KeyRecord,
  PrivateKeyHandle,
  PublicKeyHandle,
  SignatureBackend,
} from '../../src/crypto.ts';
import { LicensingError } from '../../src/errors.ts';
import { createAdvancingClock } from '../../src/id.ts';
import { InMemoryKeyStore, KeyHierarchy } from '../../src/key-hierarchy.ts';
import type { KeyAlg, LicenseKey, UUIDv7 } from '../../src/types.ts';

// -------- stub backend --------

interface StubPrivate extends PrivateKeyHandle {
  readonly secret: Uint8Array;
  readonly pub: Uint8Array;
}
interface StubPublic extends PublicKeyHandle {
  readonly pub: Uint8Array;
}

function stubBackend(alg: KeyAlg): SignatureBackend {
  return {
    alg,
    async generate(passphrase: string) {
      if (passphrase.length === 0) throw new Error('stub: empty passphrase');
      const seed = randomBytes(32);
      // "Public" == sha256(seed); gives us a deterministic public derivation.
      const pub = new Uint8Array(createHash('sha256').update(seed).digest());
      const pemHeader =
        '-----BEGIN PRIVATE KEY-----\n' +
        Buffer.from(seed).toString('base64') +
        '\n-----END PRIVATE KEY-----\n';
      const pubPem =
        '-----BEGIN PUBLIC KEY-----\n' +
        Buffer.from(pub).toString('base64') +
        '\n-----END PUBLIC KEY-----\n';
      return {
        pem: { privatePem: pemHeader, publicPem: pubPem },
        raw: { privateRaw: seed, publicRaw: pub },
      };
    },
    async importPrivate(rec: KeyRecord) {
      // Extract the raw seed from the PEM we emitted ourselves.
      const pem = rec.privatePem ?? '';
      const bi = pem.indexOf('-----BEGIN PRIVATE KEY-----');
      const ei = pem.indexOf('-----END PRIVATE KEY-----');
      if (bi < 0 || ei < 0) throw new Error('stub: bad PEM');
      const b64 = pem.slice(bi + '-----BEGIN PRIVATE KEY-----'.length, ei).replace(/\s+/g, '');
      const seed = new Uint8Array(Buffer.from(b64, 'base64'));
      const pub = new Uint8Array(createHash('sha256').update(seed).digest());
      return { secret: seed, pub } as StubPrivate;
    },
    async importPublic(rec) {
      const pem = rec.publicPem;
      const bi = pem.indexOf('-----BEGIN PUBLIC KEY-----');
      const ei = pem.indexOf('-----END PUBLIC KEY-----');
      if (bi < 0 || ei < 0) throw new Error('stub: bad pub PEM');
      const b64 = pem.slice(bi + '-----BEGIN PUBLIC KEY-----'.length, ei).replace(/\s+/g, '');
      return { pub: new Uint8Array(Buffer.from(b64, 'base64')) } as StubPublic;
    },
    async sign(priv, message) {
      const p = priv as StubPrivate;
      return new Uint8Array(createHash('sha256').update(p.secret).update(message).digest());
    },
    async verify(pub, message, sig) {
      // Stub verify is a no-op truth beacon: returns true when sig is any
      // 32-byte vector derived from the message. That's enough for the
      // orchestration tests below — attestation correctness is tested in the
      // ed25519 integration suite.
      void pub;
      void message;
      return sig.length === 32;
    },
  };
}

function mkBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([
    ['ed25519', stubBackend('ed25519')],
    ['rs256-pss', stubBackend('rs256-pss')],
    ['hs256', stubBackend('hs256')],
  ]);
}

function mkClock() {
  return createAdvancingClock('2026-04-12T10:00:00.000Z', 10);
}

// A placeholder LicenseKey row so we can exercise InMemoryKeyStore in
// isolation without constructing a full backend.
function mkKey(overrides: Partial<LicenseKey> = {}): LicenseKey {
  return {
    id: '01234567-89ab-7def-8111-000000000001' as UUIDv7,
    scope_id: null,
    kid: 'k-1',
    alg: 'ed25519',
    role: 'signing',
    state: 'active',
    public_pem: '-----BEGIN PUBLIC KEY-----\nAAA=\n-----END PUBLIC KEY-----\n',
    private_pem_enc: null,
    rotated_from: null,
    rotated_at: null,
    not_before: '2026-04-12T10:00:00.000000Z',
    not_after: null,
    meta: {},
    created_at: '2026-04-12T10:00:00.000000Z',
    updated_at: '2026-04-12T10:00:00.000000Z',
    ...overrides,
  };
}

// -------- InMemoryKeyStore --------

describe('InMemoryKeyStore', () => {
  it('round-trips through put/get/findByKid', async () => {
    const store = new InMemoryKeyStore();
    const rec = mkKey();
    await store.put(rec);
    expect(await store.get(rec.id)).toEqual(rec);
    expect(await store.findByKid(rec.kid)).toEqual(rec);
  });

  it('enforces unique kid across distinct ids', async () => {
    const store = new InMemoryKeyStore();
    await store.put(mkKey({ id: 'a-1' as UUIDv7, kid: 'shared' }));
    await expect(store.put(mkKey({ id: 'a-2' as UUIDv7, kid: 'shared' }))).rejects.toBeInstanceOf(
      LicensingError,
    );
  });

  it('allows same id to re-put (upsert)', async () => {
    const store = new InMemoryKeyStore();
    const a = mkKey({ id: 'a-1' as UUIDv7, kid: 'k', state: 'active' });
    const b = mkKey({ id: 'a-1' as UUIDv7, kid: 'k', state: 'retiring' });
    await store.put(a);
    await store.put(b);
    expect((await store.get('a-1' as UUIDv7))?.state).toBe('retiring');
  });

  it('filters by role/state/alg/scope_id', async () => {
    const store = new InMemoryKeyStore();
    await store.put(mkKey({ id: 'x-1' as UUIDv7, kid: 'root-1', role: 'root' }));
    await store.put(
      mkKey({ id: 'x-2' as UUIDv7, kid: 'sign-1', role: 'signing', state: 'active' }),
    );
    await store.put(
      mkKey({
        id: 'x-3' as UUIDv7,
        kid: 'sign-2',
        role: 'signing',
        state: 'retiring',
      }),
    );
    const actives = await store.list({ role: 'signing', state: 'active' });
    expect(actives.map((k) => k.kid)).toEqual(['sign-1']);
    const roots = await store.list({ role: 'root' });
    expect(roots.map((k) => k.kid)).toEqual(['root-1']);
  });

  it('update rejects id change and missing id', async () => {
    const store = new InMemoryKeyStore();
    await store.put(mkKey({ id: 'u-1' as UUIDv7, kid: 'u' }));
    await expect(
      store.update('u-1' as UUIDv7, mkKey({ id: 'u-2' as UUIDv7, kid: 'u' })),
    ).rejects.toBeInstanceOf(LicensingError);
    await expect(
      store.update('nonexistent' as UUIDv7, mkKey({ id: 'nonexistent' as UUIDv7, kid: 'n' })),
    ).rejects.toBeInstanceOf(LicensingError);
  });

  it('lists in stable order (created_at asc, then id asc)', async () => {
    const store = new InMemoryKeyStore();
    await store.put(
      mkKey({
        id: 'b' as UUIDv7,
        kid: 'kb',
        created_at: '2026-04-12T10:00:00.000000Z',
      }),
    );
    await store.put(
      mkKey({
        id: 'a' as UUIDv7,
        kid: 'ka',
        created_at: '2026-04-12T10:00:00.000000Z',
      }),
    );
    await store.put(
      mkKey({
        id: 'c' as UUIDv7,
        kid: 'kc',
        created_at: '2026-04-12T09:00:00.000000Z',
      }),
    );
    const all = await store.list({});
    expect(all.map((k) => k.kid)).toEqual(['kc', 'ka', 'kb']);
  });
});

// -------- KeyHierarchy orchestration --------

describe('KeyHierarchy.generateRoot', () => {
  it('refuses empty passphrase', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    await expect(
      h.generateRoot({ scope_id: null, alg: 'ed25519', passphrase: '' }),
    ).rejects.toMatchObject({ code: 'MissingKeyPassphrase' });
  });

  it('persists a root with role=root, state=active, encrypted private material', async () => {
    const store = new InMemoryKeyStore();
    const h = new KeyHierarchy({ store, backends: mkBackends(), clock: mkClock() });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rootpw',
    });
    expect(root.role).toBe('root');
    expect(root.state).toBe('active');
    expect(root.private_pem_enc).toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(root.private_pem_enc).not.toContain('-----BEGIN PRIVATE KEY-----');
    const fetched = await store.findByKid(root.kid);
    expect(fetched?.id).toBe(root.id);
  });

  it('rejects an unsupported algorithm', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: new Map(),
      clock: mkClock(),
    });
    await expect(
      h.generateRoot({ scope_id: null, alg: 'ed25519', passphrase: 'pw' }),
    ).rejects.toMatchObject({ code: 'UnsupportedAlgorithm' });
  });
});

describe('KeyHierarchy.issueSigning', () => {
  it('attaches the root attestation to meta', async () => {
    const store = new InMemoryKeyStore();
    const h = new KeyHierarchy({ store, backends: mkBackends(), clock: mkClock() });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rootpw',
    });
    const signing = await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rootpw',
      signingPassphrase: 'signpw',
    });
    expect(signing.role).toBe('signing');
    expect(signing.state).toBe('active');
    const att = (signing.meta as { root_attestation?: { root_kid?: string } }).root_attestation;
    expect(att?.root_kid).toBe(root.kid);
  });

  it('refuses a second active signing key for the same (scope, alg)', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp',
    });
    await expect(
      h.issueSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: root.kid,
        rootPassphrase: 'rp',
        signingPassphrase: 'sp2',
      }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
  });

  it('rejects an unknown root kid', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    await expect(
      h.issueSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: 'ghost',
        rootPassphrase: 'rp',
        signingPassphrase: 'sp',
      }),
    ).rejects.toMatchObject({ code: 'UnknownKid' });
  });

  it('rejects when the requested alg differs from the root alg', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await expect(
      h.issueSigning({
        scope_id: null,
        alg: 'rs256-pss',
        rootKid: root.kid,
        rootPassphrase: 'rp',
        signingPassphrase: 'sp',
      }),
    ).rejects.toMatchObject({ code: 'AlgorithmMismatch' });
  });

  it('refuses empty passphrases', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await expect(
      h.issueSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: root.kid,
        rootPassphrase: 'rp',
        signingPassphrase: '',
      }),
    ).rejects.toMatchObject({ code: 'MissingKeyPassphrase' });
    await expect(
      h.issueSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: root.kid,
        rootPassphrase: '',
        signingPassphrase: 'sp',
      }),
    ).rejects.toMatchObject({ code: 'MissingKeyPassphrase' });
  });
});

describe('KeyHierarchy.rotateSigning', () => {
  it('demotes outgoing to retiring and issues a new active, linked via rotated_from', async () => {
    const store = new InMemoryKeyStore();
    const h = new KeyHierarchy({ store, backends: mkBackends(), clock: mkClock() });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const first = await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp1',
    });
    const { outgoing, incoming } = await h.rotateSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp2',
    });

    expect(outgoing.id).toBe(first.id);
    expect(outgoing.state).toBe('retiring');
    expect(outgoing.rotated_at).not.toBeNull();

    expect(incoming.state).toBe('active');
    expect(incoming.rotated_from).toBe(first.id);
    expect(incoming.id).not.toBe(first.id);
  });

  it('post-rotation: exactly one active, one retiring for (scope, alg)', async () => {
    const store = new InMemoryKeyStore();
    const h = new KeyHierarchy({ store, backends: mkBackends(), clock: mkClock() });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp1',
    });
    await h.rotateSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp2',
    });
    const actives = await h.list({ role: 'signing', state: 'active' });
    const retiring = await h.list({ role: 'signing', state: 'retiring' });
    expect(actives.length).toBe(1);
    expect(retiring.length).toBe(1);
  });

  it('refuses to rotate when there is no active key yet', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await expect(
      h.rotateSigning({
        scope_id: null,
        alg: 'ed25519',
        rootKid: root.kid,
        rootPassphrase: 'rp',
        signingPassphrase: 'sp2',
      }),
    ).rejects.toBeInstanceOf(LicensingError);
  });

  it('clamps outgoing not_after when retireOutgoingAt is provided', async () => {
    const store = new InMemoryKeyStore();
    const h = new KeyHierarchy({ store, backends: mkBackends(), clock: mkClock() });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp1',
    });
    const cutoff = '2026-04-20T00:00:00.000000Z';
    const { outgoing } = await h.rotateSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp2',
      retireOutgoingAt: cutoff,
    });
    expect(outgoing.not_after).toBe(cutoff);
  });
});

describe('KeyHierarchy.importSigningPrivate', () => {
  it('refuses root keys outright', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    await expect(h.importSigningPrivate(root.kid, 'rp')).rejects.toBeInstanceOf(LicensingError);
  });

  it('refuses an unknown kid', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    await expect(h.importSigningPrivate('ghost', 'pw')).rejects.toMatchObject({
      code: 'UnknownKid',
    });
  });

  it('refuses an empty passphrase', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    await expect(h.importSigningPrivate('whatever', '')).rejects.toMatchObject({
      code: 'MissingKeyPassphrase',
    });
  });

  it('round-trips through wrap/unwrap: returns a usable handle', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const signing = await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp',
    });
    const { record, handle } = await h.importSigningPrivate(signing.kid, 'sp');
    expect(record.kid).toBe(signing.kid);
    expect(handle).toBeDefined();
  });

  it('surfaces KeyDecryptionFailed for a wrong passphrase', async () => {
    const h = new KeyHierarchy({
      store: new InMemoryKeyStore(),
      backends: mkBackends(),
      clock: mkClock(),
    });
    const root = await h.generateRoot({
      scope_id: null,
      alg: 'ed25519',
      passphrase: 'rp',
    });
    const signing = await h.issueSigning({
      scope_id: null,
      alg: 'ed25519',
      rootKid: root.kid,
      rootPassphrase: 'rp',
      signingPassphrase: 'sp',
    });
    await expect(h.importSigningPrivate(signing.kid, 'wrong')).rejects.toMatchObject({
      code: 'KeyDecryptionFailed',
    });
  });
});
