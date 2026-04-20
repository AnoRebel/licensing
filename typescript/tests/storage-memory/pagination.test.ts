/**
 * Cursor pagination.
 *
 * Invariants:
 *   1. Stable order: `(created_at DESC, id DESC)` for all list endpoints.
 *   2. Opaque cursor: encodes the last row's `(created_at, id)` tuple.
 *   3. No duplicates / no skips under normal operation.
 *   4. Concurrent inserts between pages MUST NOT cause skips of rows that
 *      were already visible when the previous page was emitted. (Newly-
 *      inserted rows with later IDs may or may not appear — that's
 *      fine — but nothing already returned may appear again, and nothing
 *      older than the cursor may be skipped when fetching the next page.)
 *   5. Malformed cursors reset to the first page rather than erroring.
 *
 * We test against `listLicenses` as the representative list endpoint; the
 * adapter shares a single `paginate()` helper, so the assertions generalize.
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import { createAdvancingClock, createFixedClock } from '@licensing/sdk';

import { MemoryStorage } from '../../src/storage/memory/index.ts';

function seed(n: number, prefix = 'user'): Array<Parameters<MemoryStorage['createLicense']>[0]> {
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

describe('cursor pagination — memory adapter', () => {
  let s: MemoryStorage;

  beforeEach(() => {
    // Advancing clock guarantees distinct created_at per insert so order is
    // fully determined without ties. Ties are exercised in a dedicated test
    // below.
    s = new MemoryStorage({ clock: createAdvancingClock('2026-04-13T10:00:00.000000Z') });
  });

  it('returns items in (created_at DESC, id DESC) order', async () => {
    for (const input of seed(5)) await s.createLicense(input);
    const page = await s.listLicenses({}, { limit: 100 });
    expect(page.items).toHaveLength(5);
    // DESC — later inserts come first.
    expect(page.items.map((r) => r.licensable_id)).toEqual([
      'user-0004',
      'user-0003',
      'user-0002',
      'user-0001',
      'user-0000',
    ]);
    // No cursor when the page is the whole set.
    expect(page.cursor).toBeNull();
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
    // Final page: no more rows after this one.
    expect(p3.cursor).toBeNull();
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
    // Every licensable_id exactly once.
    expect(new Set(seen).size).toBe(23);
    // DESC: starts with the most-recent insert.
    expect(seen[0]).toBe('user-0022');
    expect(seen[seen.length - 1]).toBe('user-0000');
  });

  it('concurrent inserts between pages do not cause skips of pre-existing rows', async () => {
    // Insert 10 rows, read page 1 (5 rows).
    for (const input of seed(10, 'orig')) await s.createLicense(input);
    const p1 = await s.listLicenses({}, { limit: 5 });
    expect(p1.items).toHaveLength(5);
    // Simulate concurrent activity: insert 3 newer rows before asking for
    // page 2. Those newer rows have LATER created_at (advancing clock) and
    // therefore sort BEFORE page 1's cursor under DESC — they're "beyond"
    // the cursor's back-window and MUST NOT appear on page 2.
    for (const input of seed(3, 'concurrent')) await s.createLicense(input);
    // Fetch page 2 using the original cursor.
    const p2 = await s.listLicenses({}, { limit: 5, cursor: p1.cursor ?? undefined });
    // Page 2 must contain the OTHER 5 original rows, and none of the
    // concurrent ones.
    const p2Ids = p2.items.map((r) => r.licensable_id);
    expect(p2Ids).toHaveLength(5);
    for (const id of p2Ids) {
      expect(id.startsWith('orig-')).toBe(true);
    }
    // Combined pages 1+2 cover all 10 original rows.
    const combined = [...p1.items.map((r) => r.licensable_id), ...p2Ids];
    expect(new Set(combined).size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(combined).toContain(`orig-${String(i).padStart(4, '0')}`);
    }
  });

  it('treats a malformed cursor as first page', async () => {
    for (const input of seed(3)) await s.createLicense(input);
    const page = await s.listLicenses({}, { limit: 10, cursor: 'not-a-valid-cursor' });
    // Garbage cursor decodes to null → pagination starts from the top.
    expect(page.items).toHaveLength(3);
  });

  it('breaks ties on created_at by id DESC', async () => {
    // Force ties: same created_at instant for two inserts. Use a fixed clock
    // and call createLicense twice within the same ms.
    const fixed = new MemoryStorage({
      clock: createFixedClock('2026-04-13T10:00:00.000000Z'),
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
    // UUIDv7 within the same ms carries random bits, so we cannot predict
    // which id sorts higher — but the adapter MUST still sort ties
    // deterministically (id DESC). Assert: the larger id appears first.
    const [higher, lower] = a.id > b.id ? [a, b] : [b, a];
    expect(page.items[0]?.id).toBe(higher.id);
    expect(page.items[1]?.id).toBe(lower.id);
  });

  it('paginates audit log by occurred_at DESC', async () => {
    // listAudit uses the same helper but with occurred_at as the sort key.
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
  });
});
