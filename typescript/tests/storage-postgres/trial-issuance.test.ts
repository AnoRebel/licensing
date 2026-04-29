/**
 * TrialIssuance CRUD on the Postgres adapter. Gated on LICENSING_PG_URL.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres/index.ts';
import { applyMigrations as applyPgMigrations } from '../../src/storage/postgres/migrations.ts';
import type { UUIDv7 } from '../../src/types.ts';

const PG_URL = process.env.LICENSING_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

let masterPool: Pool | null = null;
function master(): Pool {
  if (masterPool === null) masterPool = new Pool({ connectionString: PG_URL });
  return masterPool;
}

async function freshSchema(): Promise<{ s: PostgresStorage; cleanup: () => Promise<void> }> {
  const m = master();
  const schema = `trial_${Math.random().toString(36).slice(2, 10)}`;
  await m.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  const s = new PostgresStorage(pool);
  return {
    s,
    cleanup: async () => {
      await pool.end();
      await m.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

afterAll(async () => {
  if (masterPool !== null) await masterPool.end();
});

async function freshTemplate(s: PostgresStorage, name: string): Promise<UUIDv7> {
  const tmpl = await s.createTemplate({
    scope_id: null,
    parent_id: null,
    name,
    max_usages: 5,
    trial_duration_sec: 86400,
    trial_cooldown_sec: 86400 * 7,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: {},
    meta: {},
  });
  return tmpl.id;
}

describeIfPg('postgres adapter — TrialIssuance', () => {
  it('records and finds back', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const tmpl = await freshTemplate(s, 't1');
      const r = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
      const found = await s.findTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
      expect(found?.id).toBe(r.id);
    } finally {
      await cleanup();
    }
  });

  it('rejects duplicate (template, fingerprint)', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const tmpl = await freshTemplate(s, 't1');
      await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
      await expect(
        s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A }),
      ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    } finally {
      await cleanup();
    }
  });

  it('NULL template_id is its own dedupe group', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A });
      await expect(
        s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A }),
      ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
      const ok = await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_B });
      expect(ok.template_id).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('deleteTrialIssuance frees the slot', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const tmpl = await freshTemplate(s, 't1');
      const first = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
      await s.deleteTrialIssuance(first.id);
      const second = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
      expect(second.id).not.toBe(first.id);
    } finally {
      await cleanup();
    }
  });
});
