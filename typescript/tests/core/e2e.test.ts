/**
 * End-to-end core flow.
 *
 * Exercises the full issuer path as a client-facing caller would use it:
 *
 *   1. Bootstrap a scope (or use global) with root + initial signing keys.
 *   2. Create a license (directly, and via a template).
 *   3. `registerUsage` to activate the license and claim a seat.
 *   4. `issueToken` to mint a LIC1 token.
 *   5. Independent `verify()` on the token (using only the public key as a
 *      client would) produces the expected claims.
 *
 * Runs against memory + sqlite + postgres (opt-in via `LICENSING_PG_URL`).
 * This is the canary that the integration surfaces between service-layer
 * primitives don't silently drift — any regression that breaks the
 * end-to-end round-trip shows up here first.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@licensing/sdk/storage/memory';
import { PostgresStorage } from '@licensing/sdk/storage/postgres';
import { applyMigrations as applyPgMigrations } from '@licensing/sdk/storage/postgres/migrations';
import { SqliteStorage } from '@licensing/sdk/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@licensing/sdk/storage/sqlite/migrations';
import { Pool } from 'pg';

import {
  AlgorithmRegistry,
  KeyAlgBindings,
  type SignatureBackend,
} from '../../src/crypto/types.ts';
import type { Clock } from '../../src/id.ts';
import {
  createAdvancingClock,
  createLicense,
  createLicenseFromTemplate,
  createScope,
  createTemplate,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  issueToken,
  registerUsage,
  verify as verifyLic1,
} from '../../src/index.ts';
import type { Storage } from '../../src/storage/index.ts';
import type { KeyAlg, KeyRecord } from '../../src/types.ts';

function mkBackends(): ReadonlyMap<KeyAlg, SignatureBackend> {
  return new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);
}

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

async function makePgStorage() {
  const master = masterPool();
  const schema = `e2e_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
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
      return { s: new MemoryStorage({ clock }), clock, cleanup: async () => undefined };
    },
  },
  {
    name: 'sqlite',
    make: async () => {
      const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      const s = new SqliteStorage(db, { clock, skipWalPragma: true });
      return { s, clock, cleanup: async () => db.close() };
    },
  },
  ...(PG_URL ? [{ name: 'postgres', make: makePgStorage } satisfies Backend] : []),
];

afterAll(async () => {
  if (pgMaster !== null) {
    await pgMaster.end();
    pgMaster = null;
  }
});

/** Build a "client-side" verify context from a persisted signing-key row:
 *  `registry + bindings + keys` as a browser/desktop client holding only the
 *  public key would wire it up. This is intentionally verbose — we want the
 *  test to mirror what real integrators write, not hide it behind a helper
 *  that papers over wiring bugs. */
async function buildClientVerifyContext(
  s: Storage,
  kid: string,
): Promise<{
  registry: AlgorithmRegistry;
  bindings: KeyAlgBindings;
  keys: ReadonlyMap<string, KeyRecord>;
}> {
  const key = await s.getKeyByKid(kid);
  if (key === null) throw new Error(`signing key ${kid} missing`);
  const registry = new AlgorithmRegistry();
  registry.register(ed25519Backend);
  const bindings = new KeyAlgBindings();
  bindings.bind(kid, key.alg);
  const keys = new Map<string, KeyRecord>([
    [
      kid,
      {
        kid: key.kid,
        alg: key.alg,
        publicPem: key.public_pem,
        // A real client only ships the public half — privatePem=null, and
        // raw.*Raw=null mirrors the adapter's view when only public is held.
        privatePem: null,
        raw: { publicRaw: null as unknown as Uint8Array, privateRaw: null },
      },
    ],
  ]);
  return { registry, bindings, keys };
}

describe('core end-to-end', () => {
  for (const b of BACKENDS) {
    describe(b.name, () => {
      it('direct create → registerUsage → issueToken → verify round-trip', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          // 1. Bootstrap global signing key.
          const root = await generateRootKey(s, clock, mkBackends(), {
            scope_id: null,
            alg: 'ed25519',
            passphrase: 'root-pw',
          });
          const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
            scope_id: null,
            alg: 'ed25519',
            rootKid: root.kid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw',
          });

          // 2. Direct license creation.
          const lic = await createLicense(s, clock, {
            scope_id: null,
            template_id: null,
            licensable_type: 'User',
            licensable_id: 'u-direct',
            max_usages: 2,
            expires_at: '2030-01-01T00:00:00.000000Z',
            grace_until: '2030-02-01T00:00:00.000000Z',
          });
          expect(lic.status).toBe('pending');

          // 3. First registerUsage activates the license.
          const fingerprint = 'a'.repeat(64);
          const reg = await registerUsage(s, clock, {
            license_id: lic.id,
            fingerprint,
          });
          expect(reg.license.status).toBe('active');
          expect(reg.created).toBe(true);

          // 4. Issue a token.
          const result = await issueToken(s, clock, mkBackends(), {
            license: reg.license,
            usage: reg.usage,
            ttlSeconds: 3600,
            alg: 'ed25519',
            signingPassphrase: 'sign-pw',
          });
          expect(result.kid).toBe(signing.kid);

          // 5. Independent verify — as a client holding only the public key would.
          const ctx = await buildClientVerifyContext(s, signing.kid);
          const verified = await verifyLic1(result.token, ctx);
          expect(verified.payload.license_id).toBe(lic.id);
          expect(verified.payload.usage_id).toBe(reg.usage.id);
          expect(verified.payload.usage_fingerprint).toBe(fingerprint);
          expect(verified.payload.status).toBe('active');
          expect(verified.payload.max_usages).toBe(2);
          expect(verified.payload.scope).toBe('');
          expect(verified.header.kid).toBe(signing.kid);
          expect(verified.header.alg).toBe('ed25519');
          expect(verified.header.v).toBe(1);
        } finally {
          await cleanup();
        }
      });

      it('template-backed flow: scope + template → license → usage → token → verify', async () => {
        const { s, clock, cleanup } = await b.make();
        try {
          // 1. Scope + scoped signing key.
          const scope = await createScope(s, clock, { slug: 'prod', name: 'Production' });
          const root = await generateRootKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            passphrase: 'root-pw',
          });
          const signing = await issueInitialSigningKey(s, clock, mkBackends(), {
            scope_id: scope.id,
            alg: 'ed25519',
            rootKid: root.kid,
            rootPassphrase: 'root-pw',
            signingPassphrase: 'sign-pw',
          });

          // 2. Template with entitlements + force_online.
          const tpl = await createTemplate(s, clock, {
            scope_id: scope.id,
            name: 'pro-plan',
            max_usages: 3,
            trial_duration_sec: 86400 * 30, // 30-day trial
            grace_duration_sec: 86400 * 7, // 7-day grace
            force_online_after_sec: 86400, // client must re-check within a day
            entitlements: { seats: 3, featureFlags: ['export', 'sso'] },
          });

          // 3. Create license from template.
          const lic = await createLicenseFromTemplate(s, clock, {
            template_id: tpl.id,
            licensable_type: 'Org',
            licensable_id: 'org-42',
          });
          expect(lic.template_id).toBe(tpl.id);
          expect(lic.scope_id).toBe(scope.id);
          expect(lic.expires_at).not.toBeNull();
          expect(lic.grace_until).not.toBeNull();

          // 4. registerUsage → token.
          const fp = 'b'.repeat(64);
          const reg = await registerUsage(s, clock, {
            license_id: lic.id,
            fingerprint: fp,
          });
          const result = await issueToken(s, clock, mkBackends(), {
            license: reg.license,
            usage: reg.usage,
            ttlSeconds: 3600,
            alg: 'ed25519',
            signingPassphrase: 'sign-pw',
          });
          expect(result.kid).toBe(signing.kid);

          // 5. Client verify.
          const ctx = await buildClientVerifyContext(s, signing.kid);
          const verified = await verifyLic1(result.token, ctx);
          expect(verified.payload.license_id).toBe(lic.id);
          expect(verified.payload.scope).toBe('prod');
          expect(verified.payload.status).toBe('active');
          expect(verified.payload.max_usages).toBe(3);
          // Template-derived entitlements are snapshotted into the token.
          expect(verified.payload.entitlements).toEqual({
            seats: 3,
            featureFlags: ['export', 'sso'],
          });
          // force_online_after was expressed as seconds-from-iat in the template,
          // so the token carries an absolute unix-seconds deadline iat + 86400.
          expect(verified.payload.force_online_after).toBe(result.iat + 86400);
        } finally {
          await cleanup();
        }
      });
    });
  }
});
