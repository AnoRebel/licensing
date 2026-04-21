/**
 * LicenseScope service.
 *
 * Covers:
 *
 *   - `scope_id` plumbing reaches the key store unchanged, and signing keys
 *     created under a scope carry that scope through rotation.
 *   - After `rotateSigningKey`, the outgoing key is present with
 *     `state='retiring'` (so it still answers `findByKid` for token
 *     verification) and the incoming key is `active` and `rotated_from`
 *     linked — rotation does not invalidate outstanding tokens.
 *
 * Backends covered:
 *   - memory   — always.
 *   - sqlite   — always (in-memory SQLite DB).
 *   - postgres — opt-in via `LICENSING_PG_URL` env var (same per-schema
 *     isolation pattern as `tests/usage-service.test.ts`). Postgres
 *     exercises the cross-backend slug-uniqueness story and proves the
 *     Storage-backed `StorageKeyStore` id-translation holds against a real
 *     pooled backend.
 *
 * Scenarios covered per backend:
 *   - `createScope` atomicity: row + `scope.created` audit in one tx.
 *   - Slug-conflict surfaces `UniqueConstraintViolation` with no audit
 *     leak.
 *   - `generateRootKey` + `issueInitialSigningKey` write their respective
 *     audit rows and produce adapter-persisted records reachable by kid.
 *   - `rotateSigningKey` demotes outgoing → `retiring`, issues incoming
 *     `active` with `rotated_from` link, writes `key.rotated` audit.
 *   - No-op rotation (no active key) throws and leaves no audit row.
 *   - `retireOutgoingAt` clamps the outgoing `not_after`.
 *   - Cross-scope isolation: rotating scope A leaves scope B's active key
 *     untouched.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { PostgresStorage } from '@anorebel/licensing/storage/postgres';
import { applyMigrations as applyPgMigrations } from '@anorebel/licensing/storage/postgres/migrations';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';
import { Pool } from 'pg';

import type {
  KeyRecord,
  PrivateKeyHandle,
  PublicKeyHandle,
  SignatureBackend,
} from '../../src/crypto.ts';
import { LicensingError } from '../../src/errors.ts';
import { type Clock, createAdvancingClock } from '../../src/id.ts';
import {
  createScope,
  generateRootKey,
  issueInitialSigningKey,
  rotateSigningKey,
} from '../../src/scope-service.ts';
import type { Storage } from '../../src/storage/index.ts';
import type { KeyAlg } from '../../src/types.ts';

// -------- stub backend (shared shape with tests/key-hierarchy.test.ts) --------

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
      const pub = new Uint8Array(createHash('sha256').update(seed).digest());
      const privPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(seed).toString('base64')}\n-----END PRIVATE KEY-----\n`;
      const pubPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(pub).toString('base64')}\n-----END PUBLIC KEY-----\n`;
      return {
        pem: { privatePem: privPem, publicPem: pubPem },
        raw: { privateRaw: seed, publicRaw: pub },
      };
    },
    async importPrivate(rec: KeyRecord) {
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
    async verify(_pub, _message, sig) {
      return sig.length === 32;
    },
  };
}

function mkBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([['ed25519', stubBackend('ed25519')]]);
}

// -------- backend matrix --------

type Backend = {
  name: string;
  make: () => Promise<{ s: Storage; clock: Clock; cleanup: () => Promise<void> }>;
};

const PG_URL = process.env.LICENSING_PG_URL;

let pgMaster: Pool | null = null;
function masterPool(): Pool {
  if (pgMaster === null) pgMaster = new Pool({ connectionString: PG_URL });
  return pgMaster;
}

async function makePgStorage(): Promise<{
  s: Storage;
  clock: Clock;
  cleanup: () => Promise<void>;
}> {
  const master = masterPool();
  const schema = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await master.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 6 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
  const s = new PostgresStorage(pool, { clock });
  return {
    s,
    clock,
    cleanup: async () => {
      await pool.end();
      await master.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    make: async () => {
      const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
      const s = new MemoryStorage({ clock });
      return { s, clock, cleanup: async () => undefined };
    },
  },
  {
    name: 'sqlite',
    make: async () => {
      const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      const s = new SqliteStorage(db, { clock, skipWalPragma: true });
      return {
        s,
        clock,
        cleanup: async () => {
          db.close();
        },
      };
    },
  },
  ...(PG_URL ? [{ name: 'postgres', make: makePgStorage } satisfies Backend] : []),
];

async function seedActiveSigning(
  s: Storage,
  clock: Clock,
  scope_id: string | null,
): Promise<{ rootKid: string; signingKid: string }> {
  const root = await generateRootKey(s, clock, mkBackends(), {
    scope_id: scope_id as import('../../src/types.ts').UUIDv7 | null,
    alg: 'ed25519',
    passphrase: 'root-pw',
  });
  const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
    scope_id: scope_id as import('../../src/types.ts').UUIDv7 | null,
    alg: 'ed25519',
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });
  return { rootKid: root.kid, signingKid: signing.kid };
}

// -------- the suite --------

for (const backend of BACKENDS) {
  describe(`scope-service — ${backend.name} backend`, () => {
    describe('createScope', () => {
      it('persists the scope and writes a scope.created audit row atomically', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(s, clock, {
            slug: 'acme',
            name: 'Acme Corp',
            meta: { tier: 'enterprise' },
          });
          expect(scope.slug).toBe('acme');
          expect(scope.name).toBe('Acme Corp');
          expect(scope.meta).toEqual({ tier: 'enterprise' });

          const fetched = await s.getScope(scope.id);
          expect(fetched).toEqual(scope);

          const audit = await s.listAudit({ scope_id: scope.id }, { limit: 20 });
          expect(audit.items.map((r) => r.event)).toEqual(['scope.created']);
          expect(audit.items[0]?.new_state).toMatchObject({
            scope_id: scope.id,
            slug: 'acme',
            name: 'Acme Corp',
          });
        } finally {
          await cleanup();
        }
      });

      it('tags the audit row with the actor when provided', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(
            s,
            clock,
            { slug: 'acme', name: 'Acme' },
            { actor: 'ops-bot' },
          );
          const audit = await s.listAudit({ scope_id: scope.id }, { limit: 20 });
          expect(audit.items[0]?.actor).toBe('ops-bot');
        } finally {
          await cleanup();
        }
      });

      it('rejects duplicate slugs with UniqueConstraintViolation and writes no audit row', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          await createScope(s, clock, { slug: 'dup', name: 'First' });
          await expect(
            createScope(s, clock, { slug: 'dup', name: 'Second' }),
          ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
          const audit = await s.listAudit({ event: 'scope.created' }, { limit: 20 });
          expect(audit.items).toHaveLength(1);
        } finally {
          await cleanup();
        }
      });
    });

    describe('generateRootKey + issueInitialSigningKey', () => {
      it('writes key.root.issued and key.signing.issued audit rows', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(s, clock, { slug: 'acme', name: 'Acme' });
          const root = await generateRootKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            passphrase: 'root-pw',
          });
          expect(root.role).toBe('root');
          expect(root.state).toBe('active');
          expect((await s.getKeyByKid(root.kid))?.id).toBe(root.id);

          const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            rootKid: root.kid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw',
          });
          expect(signing.role).toBe('signing');
          expect(signing.state).toBe('active');

          const audit = await s.listAudit({ scope_id: scope.id }, { limit: 20 });
          const events = audit.items.map((r) => r.event).sort();
          expect(events).toEqual(['key.root.issued', 'key.signing.issued', 'scope.created']);
        } finally {
          await cleanup();
        }
      });
    });

    describe('rotateSigningKey', () => {
      it('demotes outgoing to retiring, issues new active, writes key.rotated audit', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(s, clock, { slug: 'acme', name: 'Acme' });
          const { rootKid, signingKid: outgoingKid } = await seedActiveSigning(s, clock, scope.id);

          const result = await rotateSigningKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            rootKid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw-v2',
          });

          expect(result.outgoing.kid).toBe(outgoingKid);
          expect(result.outgoing.state).toBe('retiring');
          expect(result.incoming.state).toBe('active');
          expect(result.incoming.rotated_from).toBe(result.outgoing.id);
          expect(result.incoming.kid).not.toBe(result.outgoing.kid);

          const outFetched = await s.getKeyByKid(result.outgoing.kid);
          expect(outFetched?.state).toBe('retiring');

          const keys = await s.listKeys(
            { scope_id: scope.id, role: 'signing', state: 'active' },
            { limit: 20 },
          );
          expect(keys.items).toHaveLength(1);
          expect(keys.items[0]?.kid).toBe(result.incoming.kid);

          const audit = await s.listAudit(
            { scope_id: scope.id, event: 'key.rotated' },
            { limit: 20 },
          );
          expect(audit.items).toHaveLength(1);
          expect(audit.items[0]?.new_state).toMatchObject({
            outgoing_kid: result.outgoing.kid,
            incoming_kid: result.incoming.kid,
            alg: 'ed25519',
          });
        } finally {
          await cleanup();
        }
      });

      it('throws when no active signing key exists (no audit row committed)', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(s, clock, { slug: 'empty', name: 'Empty' });
          await expect(
            rotateSigningKey(s, clock, mkBackends(), {
              scope_id: scope.id,
              alg: 'ed25519',
              rootKid: 'nonexistent',
              rootPassphrase: 'x',
              signingPassphrase: 'y',
            }),
          ).rejects.toBeInstanceOf(LicensingError);
          const audit = await s.listAudit(
            { scope_id: scope.id, event: 'key.rotated' },
            { limit: 20 },
          );
          expect(audit.items).toHaveLength(0);
        } finally {
          await cleanup();
        }
      });

      it('respects retireOutgoingAt clamp on the demoted key', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const scope = await createScope(s, clock, { slug: 'acme', name: 'Acme' });
          const { rootKid } = await seedActiveSigning(s, clock, scope.id);
          const retireAt = '2026-04-20T00:00:00.000000Z';
          const result = await rotateSigningKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            rootKid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw-v2',
            retireOutgoingAt: retireAt,
          });
          expect(result.outgoing.not_after).toBe(retireAt);
        } finally {
          await cleanup();
        }
      });

      it('scopes signing keys independently — rotation in scope A leaves scope B untouched', async () => {
        const { s, clock, cleanup } = await backend.make();
        try {
          const a = await createScope(s, clock, { slug: 'a', name: 'A' });
          const b = await createScope(s, clock, { slug: 'b', name: 'B' });
          const seedA = await seedActiveSigning(s, clock, a.id);
          const seedB = await seedActiveSigning(s, clock, b.id);

          await rotateSigningKey(s, clock, mkBackends(), {
            scope_id: a.id,
            alg: 'ed25519',
            rootKid: seedA.rootKid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw-v2',
          });

          const bActives = await s.listKeys(
            { scope_id: b.id, role: 'signing', state: 'active' },
            { limit: 20 },
          );
          expect(bActives.items.map((k) => k.kid)).toEqual([seedB.signingKid]);
        } finally {
          await cleanup();
        }
      });
    });
  });
}

afterAll(async () => {
  if (pgMaster !== null) {
    await pgMaster.end();
    pgMaster = null;
  }
});
