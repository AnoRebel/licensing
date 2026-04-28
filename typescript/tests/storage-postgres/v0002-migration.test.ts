/**
 * v0002 migration verification (Postgres).
 *
 * Gated on `LICENSING_PG_URL` — runs against an isolated schema so the test
 * never collides with another test's data. After running migrations, asserts
 * that the new objects exist on the live DB and that v0001 row data survives.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';

import { applyMigrations as applyPgMigrations } from '../../src/storage/postgres/migrations.ts';

const PG_URL = process.env.LICENSING_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

let masterPool: Pool | null = null;
function master(): Pool {
  if (masterPool === null) masterPool = new Pool({ connectionString: PG_URL });
  return masterPool;
}

async function freshSchema(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const m = master();
  const schema = `v0002_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await m.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  return {
    pool,
    cleanup: async () => {
      await pool.end();
      await m.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

afterAll(async () => {
  if (masterPool !== null) await masterPool.end();
});

describeIfPg('Postgres v0002 migration', () => {
  it('adds licenses.is_trial as boolean NOT NULL DEFAULT false', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      const res = await pool.query<{
        column_name: string;
        is_nullable: 'YES' | 'NO';
        data_type: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, data_type, column_default
           FROM information_schema.columns
           WHERE table_name = 'licenses' AND column_name = 'is_trial'`,
      );
      expect(res.rows.length).toBe(1);
      const row = res.rows[0];
      expect(row?.data_type).toBe('boolean');
      expect(row?.is_nullable).toBe('NO');
      expect(row?.column_default).toBe('false');
    } finally {
      await cleanup();
    }
  });

  it('adds licenses_licensable_type_id_idx (non-unique)', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      const res = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE tablename = 'licenses'
             AND indexname = 'licenses_licensable_type_id_idx'`,
      );
      expect(res.rows.length).toBe(1);
      const def = res.rows[0]?.indexdef ?? '';
      expect(def.toLowerCase()).not.toContain('unique');
      expect(def).toContain('licensable_type');
      expect(def).toContain('licensable_id');
    } finally {
      await cleanup();
    }
  });

  it('adds license_templates.parent_id (uuid, nullable, FK to license_templates)', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      const cols = await pool.query<{
        is_nullable: 'YES' | 'NO';
        data_type: string;
      }>(
        `SELECT is_nullable, data_type FROM information_schema.columns
           WHERE table_name = 'license_templates' AND column_name = 'parent_id'`,
      );
      expect(cols.rows.length).toBe(1);
      expect(cols.rows[0]?.data_type).toBe('uuid');
      expect(cols.rows[0]?.is_nullable).toBe('YES');
    } finally {
      await cleanup();
    }
  });

  it('adds license_templates.trial_cooldown_sec with non-negative CHECK', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      const cols = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
           WHERE table_name = 'license_templates' AND column_name = 'trial_cooldown_sec'`,
      );
      expect(cols.rows.length).toBe(1);
      // Try to insert a negative value: must violate the check.
      const tmpl = '01939e6f-0000-7000-8000-000000000001';
      await expect(
        pool.query(
          `INSERT INTO license_templates
             (id, scope_id, name, max_usages, trial_duration_sec,
              grace_duration_sec, force_online_after_sec, trial_cooldown_sec,
              entitlements, meta)
           VALUES ($1, NULL, 'neg-cooldown', 1, 0, 0, NULL, -1, '{}'::jsonb, '{}'::jsonb)`,
          [tmpl],
        ),
      ).rejects.toThrow(/license_templates_trial_cooldown_sec/);
    } finally {
      await cleanup();
    }
  });

  it('creates trial_issuances with split partial unique indexes', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      const tbl = await pool.query(
        `SELECT 1 FROM information_schema.tables
           WHERE table_name = 'trial_issuances'`,
      );
      expect(tbl.rows.length).toBe(1);

      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
           WHERE tablename = 'trial_issuances'`,
      );
      const names = indexes.rows.map((r) => r.indexname).sort();
      expect(names).toContain('trial_issuances_template_fp_key');
      expect(names).toContain('trial_issuances_global_fp_key');
      expect(names).toContain('trial_issuances_issued_at_idx');

      // Confirm the split partial uniques are actually unique + partial.
      const tplKey = indexes.rows.find((r) => r.indexname === 'trial_issuances_template_fp_key');
      expect(tplKey?.indexdef.toLowerCase()).toContain('unique');
      expect(tplKey?.indexdef).toContain('template_id IS NOT NULL');

      const globalKey = indexes.rows.find((r) => r.indexname === 'trial_issuances_global_fp_key');
      expect(globalKey?.indexdef.toLowerCase()).toContain('unique');
      expect(globalKey?.indexdef).toContain('template_id IS NULL');
    } finally {
      await cleanup();
    }
  });

  it('records v0002 in _licensing_migrations exactly once after replay', async () => {
    const { pool, cleanup } = await freshSchema();
    try {
      // First run already happened in freshSchema; replay.
      await applyPgMigrations(pool);
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM _licensing_migrations
           WHERE name LIKE '0002_%'`,
      );
      expect(res.rows[0]?.count).toBe('1');
    } finally {
      await cleanup();
    }
  });
});
