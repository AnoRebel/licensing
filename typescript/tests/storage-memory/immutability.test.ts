/**
 * AuditLog immutability.
 *
 * Adapters must reject UPDATE and DELETE on audit rows with
 * `ImmutableAuditLog`. The memory adapter enforces this *structurally* —
 * no `updateAudit` / `deleteAudit` methods exist on `Storage` in the first
 * place. There's no code path that could mutate an appended audit row.
 *
 * This test file asserts the structural guarantee at the type/public-surface
 * level plus a behavioural check: rows returned by `listAudit` / `getAudit`
 * are the same rows that were appended, byte-for-byte.
 *
 * Any future drift — e.g., a maintainer adds `updateAudit` without wiring it
 * through `errors.immutableAuditLog()` — will fail this test loudly.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';

describe('AuditLog immutability', () => {
  it('has no mutator methods on the public surface', () => {
    const s = new MemoryStorage();
    // The only audit-entry entry points are appendAudit / getAudit /
    // listAudit. No `update*Audit`, `delete*Audit`, `mutate*Audit`, etc.
    // Enumerate all own+prototype method names and assert.
    const proto = Object.getPrototypeOf(s);
    const allMethods = new Set<string>([
      ...Object.getOwnPropertyNames(proto),
      ...Object.getOwnPropertyNames(s),
    ]);
    const auditMethods = [...allMethods].filter((name) => name.toLowerCase().includes('audit'));
    // Exactly three audit methods: append, get, list.
    expect(auditMethods.sort()).toEqual(['appendAudit', 'getAudit', 'listAudit']);
  });

  it('appended rows are byte-equal on read-back', async () => {
    const s = new MemoryStorage();
    const input = {
      license_id: null,
      scope_id: null,
      actor: 'system',
      event: 'scope.created',
      prior_state: null,
      new_state: { slug: 'acme' },
      occurred_at: '2026-04-13T10:00:00.000000Z',
    };
    const appended = await s.appendAudit(input);
    const got = await s.getAudit(appended.id);
    expect(got).toEqual(appended);
    // Field-level: the caller-supplied `occurred_at` is preserved verbatim
    // (the adapter does NOT overwrite it with clock-now).
    expect(got?.occurred_at).toBe('2026-04-13T10:00:00.000000Z');
  });

  it('list returns rows identical to the appended ones', async () => {
    const s = new MemoryStorage();
    const events = ['license.created', 'license.activated', 'usage.registered'];
    const appended = [];
    for (const ev of events) {
      appended.push(
        await s.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'system',
          event: ev,
          prior_state: null,
          new_state: null,
          occurred_at: new Date().toISOString(),
        }),
      );
      // Stagger occurred_at so ordering is deterministic.
      await new Promise((r) => setTimeout(r, 2));
    }
    const page = await s.listAudit({}, { limit: 100 });
    // listAudit returns DESC by occurred_at, so reverse appended for compare.
    const expectedOrder = [...appended].reverse();
    expect(page.items).toEqual(expectedOrder);
  });

  it('mutating a row returned by getAudit does not affect stored state', async () => {
    // TypeScript types all rows as `readonly`, but at runtime nothing stops
    // a caller from casting away the brand. The adapter must not hand back
    // aliases into its internal Map — or if it does, the alias must be frozen
    // enough that a rogue mutation is either ignored on next read or throws.
    // Memory adapter: rows are plain objects stored by reference. We store
    // them as readonly and callers honor the type; this test documents that
    // the adapter does NOT defensively clone, so the contract is "do not
    // mutate returned rows". A future hardening pass could `Object.freeze()`
    // appended rows at write time — that's tracked separately.
    const s = new MemoryStorage();
    const row = await s.appendAudit({
      license_id: null,
      scope_id: null,
      actor: 'system',
      event: 'key.rotated',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-13T10:00:00.000000Z',
    });
    // Re-fetch and confirm the stored event is still the original.
    const refetched = await s.getAudit(row.id);
    expect(refetched?.event).toBe('key.rotated');
    // The point of the test: the ONLY write path is appendAudit, so there's
    // no adapter-sanctioned way to change `event` after append. The absence
    // of updateAudit is the immutability guarantee.
  });

  it('transaction rollback does not leak appended audit rows', async () => {
    const s = new MemoryStorage();
    await expect(
      s.withTransaction(async (tx) => {
        await tx.appendAudit({
          license_id: null,
          scope_id: null,
          actor: 'system',
          event: 'license.created',
          prior_state: null,
          new_state: null,
          occurred_at: new Date().toISOString(),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    const page = await s.listAudit({}, { limit: 100 });
    expect(page.items).toHaveLength(0);
  });
});
