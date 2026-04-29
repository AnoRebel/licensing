/**
 * TrialIssuance CRUD on the SQLite adapter. Mirrors the memory-adapter
 * contract test; SQLite uses split partial unique indexes for the
 * NULLS-NOT-DISTINCT semantics so this exercise also pins the migration.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { SqliteStorage } from '../../src/storage/sqlite/index.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';
import type { UUIDv7 } from '../../src/types.ts';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

function fresh(): { db: Database; s: SqliteStorage } {
  const db = new Database(':memory:');
  applyMigrations(db);
  const s = new SqliteStorage(db, { skipWalPragma: true });
  return { db, s };
}

async function freshTemplate(s: SqliteStorage, name: string): Promise<UUIDv7> {
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

describe('sqlite adapter — TrialIssuance', () => {
  it('records and finds back', async () => {
    const { db, s } = fresh();
    const tmpl = await freshTemplate(s, 't1');
    const r = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    const found = await s.findTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    expect(found?.id).toBe(r.id);
    db.close();
  });

  it('rejects duplicate (template, fingerprint) via partial unique index', async () => {
    const { db, s } = fresh();
    const tmpl = await freshTemplate(s, 't1');
    await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    await expect(
      s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    db.close();
  });

  it('NULL template_id is its own dedupe group', async () => {
    const { db, s } = fresh();
    await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A });
    await expect(
      s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_A }),
    ).rejects.toMatchObject({ code: 'UniqueConstraintViolation' });
    const ok = await s.recordTrialIssuance({ template_id: null, fingerprint_hash: FP_B });
    expect(ok.template_id).toBeNull();
    db.close();
  });

  it('deleteTrialIssuance frees the slot', async () => {
    const { db, s } = fresh();
    const tmpl = await freshTemplate(s, 't1');
    const first = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    await s.deleteTrialIssuance(first.id);
    const second = await s.recordTrialIssuance({ template_id: tmpl, fingerprint_hash: FP_A });
    expect(second.id).not.toBe(first.id);
    db.close();
  });
});
