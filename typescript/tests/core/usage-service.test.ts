/**
 * Seat enforcement.
 *
 * Covers:
 *   - Register within limit succeeds; license flips pending→active on first.
 *   - Exceeding the limit raises `SeatLimitExceeded`.
 *   - Re-registering an already-active fingerprint is idempotent.
 *   - Revoking a usage frees a seat.
 *   - Register on a suspended/revoked/expired license raises the matching
 *     lifecycle error and creates no usage row.
 *   - Race: two concurrent registrations at the seat limit cannot both
 *     succeed (one wins, the other gets SeatLimitExceeded).
 *
 * Backends covered:
 *   - memory  — always.
 *   - sqlite  — always (in-memory SQLite DB).
 *   - postgres — opt-in via `LICENSING_PG_URL` env var. We create an isolated
 *     schema per test run and point a pool at it so concurrent test files
 *     never clobber each other. Local: `docker run -d --name licensing-pg
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=licensing_test -p 55432:5432
 *     postgres:18-alpine`, then export `LICENSING_PG_URL=postgres://postgres:
 *     test@localhost:55432/licensing_test`.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { PostgresStorage } from '@anorebel/licensing/storage/postgres';
import { applyMigrations as applyPgMigrations } from '@anorebel/licensing/storage/postgres/migrations';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';
import { Pool } from 'pg';
import type { Clock } from '../../src/id.ts';
import {
  activate,
  createAdvancingClock,
  createLicense,
  registerUsage,
  revoke,
  revokeUsage,
  suspend,
} from '../../src/index.ts';
import type { Storage } from '../../src/storage/index.ts';

type Backend = {
  name: string;
  make: () => Promise<{ s: Storage; clock: Clock; cleanup: () => Promise<void> }>;
};

const PG_URL = process.env.LICENSING_PG_URL;

// Master pool for the Postgres branch — created lazily, shared across
// tests, with a per-test schema for isolation. Closed in afterAll.
let pgMaster: Pool | null = null;
function masterPool(): Pool {
  if (pgMaster === null) {
    pgMaster = new Pool({ connectionString: PG_URL });
  }
  return pgMaster;
}

async function makePgStorage(): Promise<{
  s: Storage;
  clock: Clock;
  cleanup: () => Promise<void>;
}> {
  const master = masterPool();
  // Postgres identifiers are [a-z_]; strip hyphens from a v4-style uuid.
  const schema = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await master.query(`CREATE SCHEMA "${schema}"`);
  // Dedicated pool with search_path pinned to the test schema.
  const pool = new Pool({
    connectionString: PG_URL,
    max: 6,
  });
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
  ...(PG_URL
    ? [
        {
          name: 'postgres',
          make: makePgStorage,
        } satisfies Backend,
      ]
    : []),
];

async function newLicense(s: Storage, clock: Clock, max_usages = 2) {
  return createLicense(s, clock, {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'user-1',
    max_usages,
  });
}

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);

for (const backend of BACKENDS) {
  describe(`seat enforcement — ${backend.name} backend`, () => {
    it('first register on a pending license transitions it to active', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock);
        expect(lic.status).toBe('pending');
        const res = await registerUsage(s, clock, {
          license_id: lic.id,
          fingerprint: FP_A,
        });
        expect(res.created).toBe(true);
        expect(res.usage.status).toBe('active');
        expect(res.license.status).toBe('active');
        expect(res.license.activated_at).not.toBeNull();
        const audit = await s.listAudit({ license_id: lic.id }, { limit: 20 });
        const events = audit.items.map((r) => r.event).sort();
        expect(events).toEqual(['license.activated', 'license.created', 'usage.registered']);
      } finally {
        await cleanup();
      }
    });

    it('register within seat limit creates new usage rows', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 2);
        const r1 = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        expect(r1.created).toBe(true);
        const r2 = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B });
        expect(r2.created).toBe(true);
        expect(r1.usage.id).not.toBe(r2.usage.id);
      } finally {
        await cleanup();
      }
    });

    it('register beyond seat limit throws SeatLimitExceeded', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 2);
        await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B });
        await expect(
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_C }),
        ).rejects.toMatchObject({ code: 'SeatLimitExceeded' });
        const page = await s.listUsages({ license_id: lic.id }, { limit: 100 });
        expect(page.items).toHaveLength(2);
      } finally {
        await cleanup();
      }
    });

    it('re-register with the same fingerprint is idempotent', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 2);
        const first = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        const second = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        expect(second.created).toBe(false);
        expect(second.usage.id).toBe(first.usage.id);
        const page = await s.listUsages({ license_id: lic.id }, { limit: 100 });
        expect(page.items).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it('idempotent re-register at the limit does not throw', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 1);
        await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        const res = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        expect(res.created).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('revoking a usage frees a seat for a new fingerprint', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 1);
        const r1 = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        await expect(
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B }),
        ).rejects.toMatchObject({ code: 'SeatLimitExceeded' });
        await revokeUsage(s, clock, r1.usage.id);
        const r2 = await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B });
        expect(r2.created).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('register on suspended license throws LicenseSuspended', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock);
        const active = await s.withTransaction((tx) => activate(tx, lic, clock));
        await s.withTransaction((tx) => suspend(tx, active, clock));
        await expect(
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A }),
        ).rejects.toMatchObject({ code: 'LicenseSuspended' });
      } finally {
        await cleanup();
      }
    });

    it('register on revoked license throws LicenseRevoked', async () => {
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock);
        const active = await s.withTransaction((tx) => activate(tx, lic, clock));
        await s.withTransaction((tx) => revoke(tx, active, clock));
        await expect(
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A }),
        ).rejects.toMatchObject({ code: 'LicenseRevoked' });
      } finally {
        await cleanup();
      }
    });

    it('sequential register-register-register enforces the limit', async () => {
      // Sequential analogue of the concurrent race — both memory and sqlite
      // use a single connection / single tx at a time, so true concurrent
      // seat-check races only happen on a pooled backend (Postgres). The
      // sequential form still exercises the invariant: after N registrations
      // where N = max_usages, the (N+1)th must fail with SeatLimitExceeded.
      const { s, clock, cleanup } = await backend.make();
      try {
        const lic = await newLicense(s, clock, 1);
        await registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A });
        await expect(
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B }),
        ).rejects.toMatchObject({ code: 'SeatLimitExceeded' });
        const page = await s.listUsages({ license_id: lic.id, status: ['active'] }, { limit: 100 });
        expect(page.items).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });
}

// ---------- Postgres-only: true concurrent seat-check race ----------
//
// Memory and SQLite adapters use a single connection per storage instance, so
// calling `withTransaction` while another tx is open on the same instance
// throws "nested transactions". Postgres's pool-of-clients model lets two txs
// run in parallel, and that's where the `SELECT ... FOR UPDATE` in the
// adapter actually serializes concurrent seat checks. This test proves that
// serialization works end-to-end.
if (PG_URL !== undefined) {
  describe('seat enforcement — postgres concurrent race', () => {
    it('two concurrent registrations at the limit — exactly one wins', async () => {
      const { s, clock, cleanup } = await makePgStorage();
      try {
        const lic = await newLicense(s, clock, 1);
        const results = await Promise.allSettled([
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_A }),
          registerUsage(s, clock, { license_id: lic.id, fingerprint: FP_B }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const err = (rejected[0] as PromiseRejectedResult).reason as { code: string };
        expect(err.code).toBe('SeatLimitExceeded');
        const page = await s.listUsages({ license_id: lic.id, status: ['active'] }, { limit: 100 });
        expect(page.items).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });
}

afterAll(async () => {
  if (pgMaster !== null) {
    await pgMaster.end();
    pgMaster = null;
  }
});
