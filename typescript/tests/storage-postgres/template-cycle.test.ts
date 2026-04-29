/**
 * Cycle detection on template re-parenting (Postgres adapter). Same
 * scenarios as memory + sqlite; gated on LICENSING_PG_URL.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';

import { PostgresStorage } from '../../src/storage/postgres/index.ts';
import { applyMigrations as applyPgMigrations } from '../../src/storage/postgres/migrations.ts';
import type { LicenseTemplateInput } from '../../src/storage/types.ts';
import type { UUIDv7 } from '../../src/types.ts';

const PG_URL = process.env.LICENSING_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

let masterPool: Pool | null = null;
function master(): Pool {
  if (masterPool === null) masterPool = new Pool({ connectionString: PG_URL });
  return masterPool;
}

async function freshSchema(): Promise<{ s: PostgresStorage; cleanup: () => Promise<void> }> {
  const m = master();
  const schema = `tcycle_${Math.random().toString(36).slice(2, 10)}`;
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

function tmplInput(name: string, parent_id: UUIDv7 | null = null): LicenseTemplateInput {
  return {
    scope_id: null,
    parent_id,
    name,
    max_usages: 5,
    trial_duration_sec: 0,
    trial_cooldown_sec: null,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: {},
    meta: {},
  };
}

describeIfPg('postgres adapter — template cycle detection', () => {
  it('rejects direct self-cycle on update', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const a = await s.createTemplate(tmplInput('a'));
      await expect(s.updateTemplate(a.id, { parent_id: a.id })).rejects.toMatchObject({
        code: 'TemplateCycle',
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects indirect cycle a → b → c → a', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const a = await s.createTemplate(tmplInput('a'));
      const b = await s.createTemplate(tmplInput('b', a.id));
      const c = await s.createTemplate(tmplInput('c', b.id));
      await expect(s.updateTemplate(a.id, { parent_id: c.id })).rejects.toMatchObject({
        code: 'TemplateCycle',
      });
    } finally {
      await cleanup();
    }
  });

  it('allows valid re-parenting and detach to null', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const r1 = await s.createTemplate(tmplInput('r1'));
      const r2 = await s.createTemplate(tmplInput('r2'));
      const child = await s.createTemplate(tmplInput('child', r1.id));
      const moved = await s.updateTemplate(child.id, { parent_id: r2.id });
      expect(moved.parent_id).toBe(r2.id);
      const detached = await s.updateTemplate(child.id, { parent_id: null });
      expect(detached.parent_id).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('listTemplates filters by parent_id (null and non-null)', async () => {
    const { s, cleanup } = await freshSchema();
    try {
      const r = await s.createTemplate(tmplInput('root'));
      await s.createTemplate(tmplInput('c1', r.id));
      await s.createTemplate(tmplInput('c2', r.id));
      const roots = await s.listTemplates({ parent_id: null }, { limit: 10 });
      expect(roots.items.length).toBe(1);
      const children = await s.listTemplates({ parent_id: r.id }, { limit: 10 });
      expect(children.items.length).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
