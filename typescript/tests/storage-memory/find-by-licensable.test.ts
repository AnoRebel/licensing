/**
 * findLicensesByLicensable — memory adapter coverage.
 *
 * Same scenarios as findByLicensable in the spec: matches across scopes,
 * scope-filtered lookup, ordering, no-match.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';
import type { LicenseInput } from '../../src/storage/types.ts';
import type { LicenseStatus, UUIDv7 } from '../../src/types.ts';

let counter = 0;
function freshKey(): string {
  counter++;
  return `LIC-AAAA-BBBB-CCCC-${counter.toString().padStart(4, '0')}`;
}

function inputFor(
  type: string,
  id: string,
  opts: Partial<LicenseInput> & { status?: LicenseStatus } = {},
): LicenseInput {
  return {
    scope_id: opts.scope_id ?? null,
    template_id: null,
    licensable_type: type,
    licensable_id: id,
    license_key: freshKey(),
    status: opts.status ?? 'active',
    max_usages: 5,
    activated_at: null,
    expires_at: null,
    grace_until: null,
    meta: {},
    ...opts,
  };
}

describe('memory adapter — findLicensesByLicensable', () => {
  it('returns every license attached to a (type, id) across scopes', async () => {
    const s = new MemoryStorage();
    const scope1 = await s.createScope({ slug: 's1', name: 'Scope 1', meta: {} });
    const scope2 = await s.createScope({ slug: 's2', name: 'Scope 2', meta: {} });
    await s.createLicense(inputFor('User', 'u_1', { scope_id: scope1.id }));
    await s.createLicense(inputFor('User', 'u_1', { scope_id: scope2.id }));
    await s.createLicense(inputFor('User', 'u_1')); // global scope
    await s.createLicense(inputFor('User', 'u_2', { scope_id: scope1.id }));

    const matches = await s.findLicensesByLicensable({ type: 'User', id: 'u_1' });
    expect(matches.length).toBe(3);
  });

  it('scope_id filter narrows the result', async () => {
    const s = new MemoryStorage();
    const scope1 = await s.createScope({ slug: 's1', name: 'Scope 1', meta: {} });
    await s.createLicense(inputFor('User', 'u_1', { scope_id: scope1.id }));
    await s.createLicense(inputFor('User', 'u_1'));

    const scoped = await s.findLicensesByLicensable({
      type: 'User',
      id: 'u_1',
      scope_id: scope1.id,
    });
    expect(scoped.length).toBe(1);
    expect(scoped[0]?.scope_id).toBe(scope1.id);
  });

  it('scope_id: null filters to global-scope licenses only', async () => {
    const s = new MemoryStorage();
    const scope1 = await s.createScope({ slug: 's1', name: 'Scope 1', meta: {} });
    await s.createLicense(inputFor('User', 'u_1', { scope_id: scope1.id }));
    await s.createLicense(inputFor('User', 'u_1'));

    const globalOnly = await s.findLicensesByLicensable({
      type: 'User',
      id: 'u_1',
      scope_id: null,
    });
    expect(globalOnly.length).toBe(1);
    expect(globalOnly[0]?.scope_id).toBeNull();
  });

  it('returns empty array for unknown licensable', async () => {
    const s = new MemoryStorage();
    const result = await s.findLicensesByLicensable({ type: 'User', id: 'u_unknown' });
    expect(result).toEqual([]);
  });

  it('sorts by created_at DESC', async () => {
    const s = new MemoryStorage();
    const a = await s.createLicense(inputFor('User', 'u_x'));
    // Force a tick so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    const b = await s.createLicense(
      inputFor('User', 'u_x', {
        scope_id: (await s.createScope({ slug: 'sx', name: 'X', meta: {} })).id as UUIDv7,
      }),
    );
    const matches = await s.findLicensesByLicensable({ type: 'User', id: 'u_x' });
    expect(matches.map((m) => m.id)).toEqual([b.id, a.id]);
  });
});
