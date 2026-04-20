/**
 * Cursor pagination (SQLite port).
 *
 * Parity-target: `storage-memory/tests/pagination.test.ts`. Same seven
 * scenarios, same assertions, against an in-memory SQLite DB with the
 * migration applied. The adapters share cursor encoding so a cursor
 * emitted by one is structurally identical to one emitted by the other
 * (base64url JSON `{c, i}`).
 *
 * Invariants:
 *   1. Stable order: `(created_at DESC, id DESC)` for all list endpoints.
 *   2. Opaque cursor: encodes the last row's `(created_at, id)` tuple.
 *   3. No duplicates / no skips under normal operation.
 *   4. Concurrent inserts between pages MUST NOT cause skips of rows that
 *      were already visible when the previous page was emitted.
 *   5. Malformed cursors reset to the first page rather than erroring.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createAdvancingClock, createFixedClock } from '@licensing/sdk';
import { SqliteStorage } from '../../src/storage/sqlite/index.ts';
import { applyMigrations } from '../../src/storage/sqlite/migrations.ts';

function fresh(clock = createAdvancingClock('2026-04-13T10:00:00.000000Z')) {
  const db = new Database(':memory:');
  applyMigrations(db);
  const s = new SqliteStorage(db, { clock, skipWalPragma: true });
  return { db, s };
}

function seed(n: number, prefix = 'user'): Array<Parameters<SqliteStorage['createLicense']>[0]> {
  // Pad `prefix` into the key so batches with different prefixes don't
  // collide on the global `license_key` unique constraint.
  const keyPrefix = prefix.toUpperCase().padEnd(4, 'X').slice(0, 4);
  return Array.from({ length: n }, (_, i) => ({
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: `${prefix}-${String(i).padStart(4, '0')}`,
    license_key: `LIC-${keyPrefix}-${String(i).padStart(4, '0')}-PAGE-XXXX`,
    status: 'active' as const,
    max_usages: 1,
    activated_at: null,
    expires_at: null,
    grace_until: null,
    meta: {},
  }));
}

describe('cursor pagination — sqlite adapter', () => {
  let s: SqliteStorage;
  let db: Database;

  beforeEach(() => {
    ({ s, db } = fresh());
  });

  it('returns items in (created_at DESC, id DESC) order', async () => {
    for (const input of seed(5)) await s.createLicense(input);
    const page = await s.listLicenses({}, { limit: 100 });
    expect(page.items).toHaveLength(5);
    expect(page.items.map((r) => r.licensable_id)).toEqual([
      'user-0004',
      'user-0003',
      'user-0002',
      'user-0001',
      'user-0000',
    ]);
    expect(page.cursor).toBeNull();
    db.close();
  });

  it('emits a cursor when more rows remain, null at the end', async () => {
    for (const input of seed(7)) await s.createLicense(input);
    const p1 = await s.listLicenses({}, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.cursor).not.toBeNull();
    const p2 = await s.listLicenses({}, { limit: 3, cursor: p1.cursor ?? undefined });
    expect(p2.items).toHaveLength(3);
    expect(p2.cursor).not.toBeNull();
    const p3 = await s.listLicenses({}, { limit: 3, cursor: p2.cursor ?? undefined });
    expect(p3.items).toHaveLength(1);
    expect(p3.cursor).toBeNull();
    db.close();
  });

  it('walks the full set with no duplicates and no skips', async () => {
    const inputs = seed(23);
    for (const input of inputs) await s.createLicense(input);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await s.listLicenses({}, { limit: 5, cursor });
      for (const r of page.items) seen.push(r.licensable_id);
      if (page.cursor === null) break;
      cursor = page.cursor;
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen[0]).toBe('user-0022');
    expect(seen[seen.length - 1]).toBe('user-0000');
    db.close();
  });

  it('concurrent inserts between pages do not cause skips of pre-existing rows', async () => {
    for (const input of seed(10, 'orig')) await s.createLicense(input);
    const p1 = await s.listLicenses({}, { limit: 5 });
    expect(p1.items).toHaveLength(5);
    // Newer rows have LATER created_at → sort BEFORE page 1's cursor under
    // DESC → must not appear on page 2.
    for (const input of seed(3, 'concurrent')) await s.createLicense(input);
    const p2 = await s.listLicenses({}, { limit: 5, cursor: p1.cursor ?? undefined });
    const p2Ids = p2.items.map((r) => r.licensable_id);
    expect(p2Ids).toHaveLength(5);
    for (const id of p2Ids) {
      expect(id.startsWith('orig-')).toBe(true);
    }
    const combined = [...p1.items.map((r) => r.licensable_id), ...p2Ids];
    expect(new Set(combined).size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(combined).toContain(`orig-${String(i).padStart(4, '0')}`);
    }
    db.close();
  });

  it('treats a malformed cursor as first page', async () => {
    for (const input of seed(3)) await s.createLicense(input);
    const page = await s.listLicenses({}, { limit: 10, cursor: 'not-a-valid-cursor' });
    expect(page.items).toHaveLength(3);
    db.close();
  });

  it('breaks ties on created_at by id DESC', async () => {
    // Force ties: same created_at instant for two inserts using a fixed clock.
    const fixedDb = new Database(':memory:');
    applyMigrations(fixedDb);
    const fixed = new SqliteStorage(fixedDb, {
      clock: createFixedClock('2026-04-13T10:00:00.000000Z'),
      skipWalPragma: true,
    });
    const a = await fixed.createLicense({
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'tie-a',
      license_key: 'LIC-AAAA-BBBB-CCCC-DDD1',
      status: 'active',
      max_usages: 1,
      activated_at: null,
      expires_at: null,
      grace_until: null,
      meta: {},
    });
    const b = await fixed.createLicense({
      scope_id: null,
      template_id: null,
      licensable_type: 'User',
      licensable_id: 'tie-b',
      license_key: 'LIC-AAAA-BBBB-CCCC-DDD2',
      status: 'active',
      max_usages: 1,
      activated_at: null,
      expires_at: null,
      grace_until: null,
      meta: {},
    });
    expect(a.created_at).toBe(b.created_at);
    const page = await fixed.listLicenses({}, { limit: 10 });
    // UUIDv7 within the same ms carries random bits — we can't predict which
    // id sorts higher, but the adapter MUST break ties deterministically
    // (id DESC). The higher id appears first.
    const [higher, lower] = a.id > b.id ? [a, b] : [b, a];
    expect(page.items[0]?.id).toBe(higher.id);
    expect(page.items[1]?.id).toBe(lower.id);
    fixedDb.close();
  });

  it('paginates audit log by occurred_at DESC', async () => {
    const base = Date.UTC(2026, 3, 13, 10, 0, 0);
    for (let i = 0; i < 5; i++) {
      await s.appendAudit({
        license_id: null,
        scope_id: null,
        actor: 'system',
        event: `event-${i}`,
        prior_state: null,
        new_state: null,
        occurred_at: new Date(base + i * 1000).toISOString(),
      });
    }
    const p1 = await s.listAudit({}, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.items.map((r) => r.event)).toEqual(['event-4', 'event-3', 'event-2']);
    const p2 = await s.listAudit({}, { limit: 3, cursor: p1.cursor ?? undefined });
    expect(p2.items.map((r) => r.event)).toEqual(['event-1', 'event-0']);
    expect(p2.cursor).toBeNull();
    db.close();
  });
});
