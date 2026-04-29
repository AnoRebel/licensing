/**
 * Cycle detection on template re-parenting (SQLite adapter). Same scenarios
 * as the memory-adapter test; the adapter walks the chain in app code, so
 * sqlite uses a real DB with foreign_keys = ON.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { SqliteStorage } from '../../src/storage/sqlite/index.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';
import type { LicenseTemplateInput } from '../../src/storage/types.ts';
import type { UUIDv7 } from '../../src/types.ts';

function fresh(): { db: Database; s: SqliteStorage } {
  const db = new Database(':memory:');
  applyMigrations(db);
  const s = new SqliteStorage(db, { skipWalPragma: true });
  return { db, s };
}

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

describe('sqlite adapter — template cycle detection', () => {
  it('rejects direct self-cycle on update (parent_id = self.id)', async () => {
    const { db, s } = fresh();
    const a = await s.createTemplate(tmplInput('a'));
    await expect(s.updateTemplate(a.id, { parent_id: a.id })).rejects.toMatchObject({
      code: 'TemplateCycle',
    });
    db.close();
  });

  it('rejects indirect cycle a → b → c → a', async () => {
    const { db, s } = fresh();
    const a = await s.createTemplate(tmplInput('a'));
    const b = await s.createTemplate(tmplInput('b', a.id));
    const c = await s.createTemplate(tmplInput('c', b.id));
    await expect(s.updateTemplate(a.id, { parent_id: c.id })).rejects.toMatchObject({
      code: 'TemplateCycle',
    });
    db.close();
  });

  it('allows valid re-parenting and detaching to null', async () => {
    const { db, s } = fresh();
    const r1 = await s.createTemplate(tmplInput('r1'));
    const r2 = await s.createTemplate(tmplInput('r2'));
    const child = await s.createTemplate(tmplInput('child', r1.id));
    const moved = await s.updateTemplate(child.id, { parent_id: r2.id });
    expect(moved.parent_id).toBe(r2.id);
    const detached = await s.updateTemplate(child.id, { parent_id: null });
    expect(detached.parent_id).toBeNull();
    db.close();
  });

  it('listTemplates filters by parent_id (null = roots only)', async () => {
    const { db, s } = fresh();
    const r = await s.createTemplate(tmplInput('root'));
    await s.createTemplate(tmplInput('c1', r.id));
    await s.createTemplate(tmplInput('c2', r.id));
    const roots = await s.listTemplates({ parent_id: null }, { limit: 10 });
    expect(roots.items.length).toBe(1);
    const children = await s.listTemplates({ parent_id: r.id }, { limit: 10 });
    expect(children.items.length).toBe(2);
    db.close();
  });
});
