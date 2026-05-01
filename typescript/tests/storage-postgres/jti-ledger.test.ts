/**
 * Postgres JtiLedger conformance.
 *
 * Mirrors the in-memory reference suite in tests/client/jti-ledger.test.ts
 * and the SQLite adapter suite. Gated on LICENSING_PG_URL — runs against
 * an isolated schema per test so collisions never happen.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';

import { PostgresJtiLedger } from '../../src/storage/postgres/jti-ledger.ts';
import { applyMigrations as applyPgMigrations } from '../../src/storage/postgres/migrations.ts';

const PG_URL = process.env.LICENSING_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

let masterPool: Pool | null = null;
function master(): Pool {
  if (masterPool === null) masterPool = new Pool({ connectionString: PG_URL });
  return masterPool;
}

async function freshSchema(): Promise<{
  ledger: PostgresJtiLedger;
  cleanup: () => Promise<void>;
}> {
  const m = master();
  const schema = `jti_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await m.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 6 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  return {
    ledger: new PostgresJtiLedger(pool),
    cleanup: async () => {
      await pool.end();
      await m.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

afterAll(async () => {
  if (masterPool !== null) await masterPool.end();
});

describeIfPg('PostgresJtiLedger', () => {
  it('first use is recorded and reported as first', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      expect(await ledger.recordJtiUse('jti-a', 2_000_000_100)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('second use of the same jti is rejected', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      await ledger.recordJtiUse('jti-a', 2_000_000_100);
      expect(await ledger.recordJtiUse('jti-a', 2_000_000_100)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('distinct jtis coexist as first-use', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      for (const jti of ['a', 'b', 'c']) {
        expect(await ledger.recordJtiUse(jti, 2_000_000_100)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('pruneExpired removes rows whose expires_at ≤ nowSec', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      await ledger.recordJtiUse('expired-1', 100);
      await ledger.recordJtiUse('expired-2', 200);
      await ledger.recordJtiUse('alive', 9_000_000_000);
      expect(await ledger.pruneExpired(500)).toBe(2);
      expect(await ledger.pruneExpired(500)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('pruneExpired boundary is inclusive', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      await ledger.recordJtiUse('exact', 1_000);
      expect(await ledger.pruneExpired(1_000)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('pruned jti can be re-recorded as first-use', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      await ledger.recordJtiUse('rotated', 100);
      await ledger.pruneExpired(500);
      expect(await ledger.recordJtiUse('rotated', 9_000_000_000)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('contended writes produce exactly one first-use winner', async () => {
    const { ledger, cleanup } = await freshSchema();
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => ledger.recordJtiUse('contended', 2_000_000_100)),
      );
      const firsts = results.filter((r) => r === true).length;
      expect(firsts).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
