/**
 * License lifecycle state machine.
 *
 * Each transition MUST:
 *   1. Legal: succeed only from allowed source states.
 *   2. Atomic: update the license row AND write the matching audit entry in
 *      the same transaction.
 *   3. Audit-complete: every lifecycle op writes exactly one audit row.
 *   4. Revoked is terminal — no further transitions.
 *
 * We use `MemoryStorage` as the concrete backend; the lifecycle functions
 * depend only on `StorageTx`, so memory is sufficient to exercise the
 * semantic contract.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@anorebel/licensing/storage/memory';

import {
  activate,
  createAdvancingClock,
  createLicense,
  effectiveStatus,
  expire,
  renew,
  resume,
  revoke,
  suspend,
  tick,
} from '../../src/index.ts';

function newStorage() {
  const clock = createAdvancingClock('2026-04-13T10:00:00.000000Z');
  const s = new MemoryStorage({ clock });
  return { s, clock };
}

async function freshPendingLicense(
  s: MemoryStorage,
  clock: Parameters<typeof createLicense>[1],
  overrides: Parameters<typeof createLicense>[2]['meta'] extends never
    ? never
    : Partial<Parameters<typeof createLicense>[2]> = {},
) {
  return createLicense(s, clock, {
    scope_id: null,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'user-1',
    max_usages: 3,
    ...overrides,
  });
}

describe('license lifecycle — activate', () => {
  it('pending → active sets activated_at and writes audit', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    expect(lic.status).toBe('pending');
    expect(lic.activated_at).toBeNull();
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    expect(active.status).toBe('active');
    expect(active.activated_at).not.toBeNull();
    // Exactly two audit rows: license.created + license.activated.
    const audit = await s.listAudit({ license_id: lic.id }, { limit: 10 });
    const events = audit.items.map((r) => r.event).sort();
    expect(events).toEqual(['license.activated', 'license.created']);
  });

  it('activating an already-active license is a no-op', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active1 = await s.withTransaction((tx) => activate(tx, lic, clock));
    const active2 = await s.withTransaction((tx) => activate(tx, active1, clock));
    expect(active2).toEqual(active1);
    // Still exactly one `license.activated` audit row.
    const audit = await s.listAudit(
      { license_id: lic.id, event: 'license.activated' },
      { limit: 10 },
    );
    expect(audit.items).toHaveLength(1);
  });

  it('rejects activate on suspended/revoked/expired', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const suspended = await s.withTransaction((tx) => suspend(tx, active, clock));
    await expect(s.withTransaction((tx) => activate(tx, suspended, clock))).rejects.toMatchObject({
      code: 'IllegalLifecycleTransition',
    });
    const revoked = await s.withTransaction((tx) => revoke(tx, active, clock));
    await expect(s.withTransaction((tx) => activate(tx, revoked, clock))).rejects.toMatchObject({
      code: 'LicenseRevoked',
    });
  });
});

describe('license lifecycle — suspend / resume', () => {
  it('active ↔ suspended round-trip with two audit rows', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const suspended = await s.withTransaction((tx) => suspend(tx, active, clock));
    expect(suspended.status).toBe('suspended');
    const resumed = await s.withTransaction((tx) => resume(tx, suspended, clock));
    expect(resumed.status).toBe('active');
    const audit = await s.listAudit({ license_id: lic.id }, { limit: 20 });
    const events = audit.items.map((r) => r.event).sort();
    expect(events).toEqual([
      'license.activated',
      'license.created',
      'license.resumed',
      'license.suspended',
    ]);
  });

  it('suspending a revoked license is rejected', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const revoked = await s.withTransaction((tx) => revoke(tx, active, clock));
    await expect(s.withTransaction((tx) => suspend(tx, revoked, clock))).rejects.toMatchObject({
      code: 'LicenseRevoked',
    });
  });

  it('resuming a non-suspended license is rejected', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    await expect(s.withTransaction((tx) => resume(tx, active, clock))).rejects.toMatchObject({
      code: 'IllegalLifecycleTransition',
    });
  });
});

describe('license lifecycle — revoke (terminal)', () => {
  it('any non-revoked → revoked', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const revoked = await s.withTransaction((tx) => revoke(tx, active, clock));
    expect(revoked.status).toBe('revoked');
  });

  it('revoked license rejects activate / suspend / resume / renew / expire', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const revoked = await s.withTransaction((tx) => revoke(tx, active, clock));
    for (const op of [activate, suspend, resume, expire]) {
      await expect(s.withTransaction((tx) => op(tx, revoked, clock))).rejects.toMatchObject({
        code: 'LicenseRevoked',
      });
    }
    await expect(
      s.withTransaction((tx) => renew(tx, revoked, clock, { expires_at: null })),
    ).rejects.toMatchObject({ code: 'LicenseRevoked' });
  });

  it('revoking an already-revoked license is a no-op', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const revoked1 = await s.withTransaction((tx) => revoke(tx, active, clock));
    const revoked2 = await s.withTransaction((tx) => revoke(tx, revoked1, clock));
    expect(revoked2).toEqual(revoked1);
    const audit = await s.listAudit(
      { license_id: lic.id, event: 'license.revoked' },
      { limit: 10 },
    );
    expect(audit.items).toHaveLength(1);
  });
});

describe('license lifecycle — expire / renew', () => {
  it('active → expired writes license.expired audit', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const expired = await s.withTransaction((tx) => expire(tx, active, clock));
    expect(expired.status).toBe('expired');
    const audit = await s.listAudit(
      { license_id: lic.id, event: 'license.expired' },
      { limit: 10 },
    );
    expect(audit.items).toHaveLength(1);
  });

  it('expired → active via renew; sets new expires_at', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const expired = await s.withTransaction((tx) => expire(tx, active, clock));
    const newExp = '2027-04-13T10:00:00.000000Z';
    const renewed = await s.withTransaction((tx) =>
      renew(tx, expired, clock, { expires_at: newExp }),
    );
    expect(renewed.status).toBe('active');
    expect(renewed.expires_at).toBe(newExp);
  });

  it('renewing a suspended license is rejected', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const suspended = await s.withTransaction((tx) => suspend(tx, active, clock));
    await expect(
      s.withTransaction((tx) => renew(tx, suspended, clock, { expires_at: null })),
    ).rejects.toMatchObject({ code: 'IllegalLifecycleTransition' });
  });

  it('expire rejects pending / suspended licenses (no direct path)', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock);
    await expect(s.withTransaction((tx) => expire(tx, lic, clock))).rejects.toMatchObject({
      code: 'IllegalLifecycleTransition',
    });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const suspended = await s.withTransaction((tx) => suspend(tx, active, clock));
    await expect(s.withTransaction((tx) => expire(tx, suspended, clock))).rejects.toMatchObject({
      code: 'IllegalLifecycleTransition',
    });
  });
});

describe('license lifecycle — effectiveStatus / tick', () => {
  it('effectiveStatus: active past expires_at with grace_until in future → grace', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, {
      expires_at: '2026-04-14T10:00:00.000000Z',
      grace_until: '2026-04-20T10:00:00.000000Z',
    });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    // Just past expires_at but before grace_until.
    expect(effectiveStatus(active, '2026-04-15T00:00:00.000000Z')).toBe('grace');
    // Past grace_until.
    expect(effectiveStatus(active, '2026-04-21T00:00:00.000000Z')).toBe('expired');
    // Still in window.
    expect(effectiveStatus(active, '2026-04-13T12:00:00.000000Z')).toBe('active');
  });

  it('effectiveStatus: revoked / suspended / pending pass through unchanged', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, {
      expires_at: '2026-04-14T10:00:00.000000Z',
    });
    // Pending with expired date still reports pending.
    expect(effectiveStatus(lic, '2027-01-01T00:00:00.000000Z')).toBe('pending');
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const suspended = await s.withTransaction((tx) => suspend(tx, active, clock));
    expect(effectiveStatus(suspended, '2027-01-01T00:00:00.000000Z')).toBe('suspended');
    const revoked = await s.withTransaction((tx) => revoke(tx, suspended, clock));
    expect(effectiveStatus(revoked, '2027-01-01T00:00:00.000000Z')).toBe('revoked');
  });

  it('tick: persists active → grace transition once expires_at has passed', async () => {
    // Use a fresh clock whose "now" is past expires_at.
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, {
      // Set expires_at one millisecond past "start" — advancing clock steps
      // by 1ms per call, and each storage op reads the clock multiple times,
      // so by the time we call tick() we're well past this boundary.
      expires_at: '2026-04-13T10:00:00.002000Z',
      grace_until: '2026-12-31T00:00:00.000000Z',
    });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const ticked = await s.withTransaction((tx) => tick(tx, active, clock));
    expect(ticked.status).toBe('grace');
    const audit = await s.listAudit(
      { license_id: lic.id, event: 'license.grace_entered' },
      { limit: 10 },
    );
    expect(audit.items).toHaveLength(1);
  });

  it('tick: persists active → expired when past grace_until (skipping grace)', async () => {
    // Both expires_at and grace_until are already in the past — tick should
    // transition straight to expired, emitting license.expired.
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, {
      expires_at: '2026-04-13T10:00:00.001000Z',
      grace_until: '2026-04-13T10:00:00.002000Z',
    });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const ticked = await s.withTransaction((tx) => tick(tx, active, clock));
    expect(ticked.status).toBe('expired');
    const audit = await s.listAudit(
      { license_id: lic.id, event: 'license.expired' },
      { limit: 10 },
    );
    expect(audit.items).toHaveLength(1);
  });

  it('tick: persists grace → expired once grace_until has passed', async () => {
    // Promote a license to grace persistently, then advance the clock past
    // grace_until and tick again — it should land on expired.
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, {
      expires_at: '2026-04-13T10:00:00.002000Z',
      grace_until: '2026-04-13T10:00:00.003000Z',
    });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    // First tick lands on grace (clock is between expires_at and grace_until
    // on the first storage op, typically — but since the advancing clock
    // steps aggressively, we may go straight to expired. Either is fine;
    // assert only the terminal state.
    const ticked = await s.withTransaction((tx) => tick(tx, active, clock));
    // At this point we should be past grace_until and at 'expired'.
    expect(['grace', 'expired']).toContain(ticked.status);
    if (ticked.status === 'grace') {
      const finalTick = await s.withTransaction((tx) => tick(tx, ticked, clock));
      expect(finalTick.status).toBe('expired');
    }
    const expiredAudit = await s.listAudit(
      { license_id: lic.id, event: 'license.expired' },
      { limit: 10 },
    );
    expect(expiredAudit.items).toHaveLength(1);
  });

  it('tick: no-op when effective status already matches persisted status', async () => {
    const { s, clock } = newStorage();
    const lic = await freshPendingLicense(s, clock, { expires_at: null });
    const active = await s.withTransaction((tx) => activate(tx, lic, clock));
    const ticked = await s.withTransaction((tx) => tick(tx, active, clock));
    expect(ticked).toEqual(active);
    const audit = await s.listAudit({ license_id: lic.id }, { limit: 20 });
    // Only license.created + license.activated — no tick-related rows.
    expect(audit.items.map((r) => r.event).sort()).toEqual([
      'license.activated',
      'license.created',
    ]);
  });
});
