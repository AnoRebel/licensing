/**
 * AuditLogFilter — extended filter coverage (events array, licensable join,
 * actor, since/until). The plain filter behaviour (license_id, scope_id,
 * event string) is exercised by the broader audit tests; this file pins the
 * new fields added in v0002.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';
import type { LicenseInput } from '../../src/storage/types.ts';

let licCounter = 0;
function freshLic(licensable_id: string): LicenseInput {
  licCounter++;
  return {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id,
    license_key: `LIC-AAAA-${licCounter.toString().padStart(4, '0')}`,
    status: 'active',
    max_usages: 5,
    activated_at: null,
    expires_at: null,
    grace_until: null,
    meta: {},
  };
}

describe('memory listAudit — extended filters', () => {
  it('filters by event-array', async () => {
    const s = new MemoryStorage();
    const lic = await s.createLicense(freshLic('u1'));
    await s.appendAudit({
      license_id: lic.id,
      scope_id: null,
      actor: 'system',
      event: 'license.created',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-01T00:00:00.000000Z',
    });
    await s.appendAudit({
      license_id: lic.id,
      scope_id: null,
      actor: 'admin',
      event: 'license.refreshed',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-02T00:00:00.000000Z',
    });
    await s.appendAudit({
      license_id: lic.id,
      scope_id: null,
      actor: 'system',
      event: 'usage.registered',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-03T00:00:00.000000Z',
    });
    const matches = await s.listAudit(
      { event: ['license.created', 'license.refreshed'] },
      { limit: 10 },
    );
    expect(matches.items.length).toBe(2);
    expect(matches.items.map((r) => r.event).sort()).toEqual([
      'license.created',
      'license.refreshed',
    ]);
  });

  it('filters by actor', async () => {
    const s = new MemoryStorage();
    const lic = await s.createLicense(freshLic('u1'));
    await s.appendAudit({
      license_id: lic.id,
      scope_id: null,
      actor: 'system',
      event: 'a',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-01T00:00:00.000000Z',
    });
    await s.appendAudit({
      license_id: lic.id,
      scope_id: null,
      actor: 'admin',
      event: 'b',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-02T00:00:00.000000Z',
    });
    const onlyAdmin = await s.listAudit({ actor: 'admin' }, { limit: 10 });
    expect(onlyAdmin.items.length).toBe(1);
    expect(onlyAdmin.items[0]?.actor).toBe('admin');
  });

  it('filters by since/until window (since inclusive, until exclusive)', async () => {
    const s = new MemoryStorage();
    const lic = await s.createLicense(freshLic('u1'));
    for (const ts of [
      '2026-03-31T12:00:00.000000Z',
      '2026-04-01T00:00:00.000000Z',
      '2026-04-15T00:00:00.000000Z',
      '2026-05-01T00:00:00.000000Z',
    ]) {
      await s.appendAudit({
        license_id: lic.id,
        scope_id: null,
        actor: 'system',
        event: 'e',
        prior_state: null,
        new_state: null,
        occurred_at: ts,
      });
    }
    const inRange = await s.listAudit(
      { since: '2026-04-01T00:00:00.000000Z', until: '2026-05-01T00:00:00.000000Z' },
      { limit: 10 },
    );
    // Only the two entries on Apr 1 and Apr 15 (since inclusive, until exclusive).
    expect(inRange.items.length).toBe(2);
  });

  it('filters by licensable_type/licensable_id (joins via licenses)', async () => {
    const s = new MemoryStorage();
    const u1Lic = await s.createLicense(freshLic('u1'));
    const u2Lic = await s.createLicense(freshLic('u2'));
    await s.appendAudit({
      license_id: u1Lic.id,
      scope_id: null,
      actor: 'system',
      event: 'license.created',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-01T00:00:00.000000Z',
    });
    await s.appendAudit({
      license_id: u2Lic.id,
      scope_id: null,
      actor: 'system',
      event: 'license.created',
      prior_state: null,
      new_state: null,
      occurred_at: '2026-04-02T00:00:00.000000Z',
    });
    const onlyU1 = await s.listAudit(
      { licensable_type: 'User', licensable_id: 'u1' },
      { limit: 10 },
    );
    expect(onlyU1.items.length).toBe(1);
    expect(onlyU1.items[0]?.license_id).toBe(u1Lic.id);
  });
});
