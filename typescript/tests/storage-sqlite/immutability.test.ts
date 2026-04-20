/**
 * AuditLog immutability test.
 *
 * SQLite adapter enforces immutability at two layers:
 *   1. No mutator method on the public surface (only append/get/list).
 *   2. BEFORE UPDATE/DELETE triggers on `audit_logs` that raise with
 *      `ImmutableAuditLog: ...` — the error mapper catches the prefix and
 *      converts it to `errors.immutableAuditLog()`.
 *
 * This test covers both layers:
 *   - Reflects the adapter surface to assert no unexpected audit methods.
 *   - Appends rows, asserts byte-equal read-back and list round-trip.
 *   - Triggers the DB-level UPDATE/DELETE paths via raw SQL and asserts the
 *     core `ImmutableAuditLog` error.
 *   - Tests transaction rollback: an appended row inside a rolled-back tx
 *     is not visible afterward.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SqliteStorage } from '../../src/storage/sqlite/index.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';

function fresh(): { db: Database; s: SqliteStorage } {
  const db = new Database(':memory:');
  applyMigrations(db);
  const s = new SqliteStorage(db, { skipWalPragma: true });
  return { db, s };
}

describe('SqliteStorage — audit immutability', () => {
  it('public surface exposes only append/get/list for audit', () => {
    const methods = Object.getOwnPropertyNames(SqliteStorage.prototype).filter((n) =>
      /audit/i.test(n),
    );
    methods.sort();
    expect(methods).toEqual(['appendAudit', 'getAudit', 'listAudit']);
  });

  it('appended rows are byte-equal on read-back', async () => {
    const { s, db } = fresh();
    const entry = await s.appendAudit({
      license_id: null,
      scope_id: null,
      actor: 'system',
      event: 'license.created',
      prior_state: null,
      new_state: { status: 'active' },
      occurred_at: new Date().toISOString(),
    });
    const fetched = await s.getAudit(entry.id);
    expect(fetched).toEqual(entry);
    const page = await s.listAudit({}, { limit: 10 });
    expect(page.items).toEqual([entry]);
    db.close();
  });

  it('UPDATE on audit_logs raises ImmutableAuditLog via trigger', async () => {
    const { s, db } = fresh();
    const entry = await s.appendAudit({
      license_id: null,
      scope_id: null,
      actor: 'system',
      event: 'test',
      prior_state: null,
      new_state: null,
      occurred_at: new Date().toISOString(),
    });
    expect(() =>
      db.query('UPDATE audit_logs SET actor = ? WHERE id = ?').run('tamper', entry.id),
    ).toThrow(/ImmutableAuditLog/i);
    db.close();
  });

  it('DELETE on audit_logs raises ImmutableAuditLog via trigger', async () => {
    const { s, db } = fresh();
    const entry = await s.appendAudit({
      license_id: null,
      scope_id: null,
      actor: 'system',
      event: 'test',
      prior_state: null,
      new_state: null,
      occurred_at: new Date().toISOString(),
    });
    expect(() => db.query('DELETE FROM audit_logs WHERE id = ?').run(entry.id)).toThrow(
      /ImmutableAuditLog/i,
    );
    db.close();
  });

  it('rollback drops audit rows appended inside the transaction', async () => {
    const { s, db } = fresh();
    await expect(
      s.withTransaction(async (tx) => {
        await tx.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'system',
          event: 'test',
          prior_state: null,
          new_state: null,
          occurred_at: new Date().toISOString(),
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const page = await s.listAudit({}, { limit: 10 });
    expect(page.items).toEqual([]);
    db.close();
  });
});
