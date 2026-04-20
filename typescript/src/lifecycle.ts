/**
 * License lifecycle state machine.
 *
 * The license goes through these states:
 *
 *                 ┌───────────┐
 *                 │  pending  │
 *                 └─────┬─────┘
 *                       │ activate()
 *                       ▼
 *      ┌──────────┐   ┌────────┐   ┌─────────┐   ┌─────────┐
 *      │ suspend  │◀──│ active │──▶│  grace  │──▶│ expired │
 *      │          │──▶│        │   │ (auto)  │   │ (auto)  │
 *      └──────────┘ r │        │   └─────────┘   └─────────┘
 *            │      e │        │         (past grace_until,
 *   suspend  │      s │        │          tick() fires)
 *    (any    │      u │        │
 *     non-   │      m │        │
 *     rev.)  │      e │        │
 *            ▼        │        │
 *      ┌──────────┐   │        │
 *      │ revoked  │◀──┴────────┘ revoke()  (terminal)
 *      └──────────┘
 *
 * Rules:
 *   - `pending → active` via `activate()` or first successful `registerUsage`.
 *   - `active ↔ suspended` via `suspend` / `resume`.
 *   - `active → grace` is computed, not persisted: reading the license when
 *     now ∈ [expires_at, grace_until) reports `grace`. Persisting grace via
 *     `tick()` on a scheduled sweep is also supported.
 *   - `grace → expired` persists via `expire()` after grace_until passes.
 *   - `* → revoked` via `revoke()`; terminal (no further transitions allowed).
 *   - `expired → active` via `renew()` (sets new expires_at/grace_until).
 *   - Every successful transition writes a single audit row in the same tx.
 *
 * The functions below take a `StorageTx` handle and MUST be called inside
 * `storage.withTransaction(...)`. They are transaction-atomic: the license
 * row is updated and the audit row appended in the same atomic unit.
 */

import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import type { StorageTx } from './storage/types.ts';
import type { JSONValue, License, LicenseStatus, UUIDv7 } from './types.ts';

/** Actor attribution for audit log. Defaults to `'system'` when omitted. */
export interface TransitionOptions {
  readonly actor?: string;
}

/** Options for `renew`. Caller supplies the new end timestamps explicitly —
 *  lifecycle has no opinion on trial/subscription duration math. */
export interface RenewOptions extends TransitionOptions {
  readonly expires_at: string | null;
  readonly grace_until?: string | null;
}

// ---------- effective-status helpers ----------

/**
 * Compute the *effective* status of a license given a clock instant, without
 * mutating storage. Used by read paths that want to display/return "grace"
 * when the license has passed `expires_at` but is still within `grace_until`,
 * even if the persisted `status` column hasn't been flipped by a sweeper.
 */
export function effectiveStatus(license: License, nowIso: string): LicenseStatus {
  // Terminal / non-time-dependent states pass through untouched.
  if (license.status === 'revoked') return 'revoked';
  if (license.status === 'suspended') return 'suspended';
  if (license.status === 'pending') return 'pending';
  if (license.status === 'expired') return 'expired';

  // Active or grace — check expiry boundaries.
  const { expires_at, grace_until } = license;
  if (expires_at !== null && nowIso >= expires_at) {
    if (grace_until !== null && nowIso < grace_until) return 'grace';
    return 'expired';
  }
  return license.status; // 'active' or already-'grace'
}

// ---------- transitions ----------

/** `pending → active`. No-op (returns license unchanged) if already active. */
export async function activate(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  assertNotRevoked(license);
  if (license.status === 'active') return license;
  if (license.status !== 'pending') {
    throw illegalTransition(license.status, 'active');
  }
  const now = clock.nowIso();
  const updated = await tx.updateLicense(license.id, {
    status: 'active',
    activated_at: now,
  });
  await writeAudit(tx, license, updated, 'license.activated', now, opts.actor);
  return updated;
}

/** `active → suspended`. Revoked is rejected; any other non-revoked state is
 *  accepted (suspending an already-suspended license is a no-op). */
export async function suspend(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  assertNotRevoked(license);
  if (license.status === 'suspended') return license;
  const now = clock.nowIso();
  const updated = await tx.updateLicense(license.id, { status: 'suspended' });
  await writeAudit(tx, license, updated, 'license.suspended', now, opts.actor);
  return updated;
}

/** `suspended → active`. */
export async function resume(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  assertNotRevoked(license);
  if (license.status !== 'suspended') {
    throw illegalTransition(license.status, 'active');
  }
  const now = clock.nowIso();
  const updated = await tx.updateLicense(license.id, { status: 'active' });
  await writeAudit(tx, license, updated, 'license.resumed', now, opts.actor);
  return updated;
}

/** Terminal `* → revoked`. Revoking an already-revoked license is a no-op. */
export async function revoke(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  if (license.status === 'revoked') return license;
  const now = clock.nowIso();
  const updated = await tx.updateLicense(license.id, { status: 'revoked' });
  await writeAudit(tx, license, updated, 'license.revoked', now, opts.actor);
  return updated;
}

/** `active|grace → expired`. Used by scheduled sweepers after `grace_until`. */
export async function expire(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  assertNotRevoked(license);
  if (license.status === 'expired') return license;
  if (license.status === 'suspended' || license.status === 'pending') {
    throw illegalTransition(license.status, 'expired');
  }
  const now = clock.nowIso();
  const updated = await tx.updateLicense(license.id, { status: 'expired' });
  await writeAudit(tx, license, updated, 'license.expired', now, opts.actor);
  return updated;
}

/** `expired|active|grace → active` with new end timestamps. Suspended and
 *  revoked licenses cannot be renewed — resume or unrevoke-is-not-allowed. */
export async function renew(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: RenewOptions,
): Promise<License> {
  assertNotRevoked(license);
  if (license.status === 'suspended') {
    throw illegalTransition(license.status, 'active');
  }
  const now = clock.nowIso();
  const patch: Parameters<StorageTx['updateLicense']>[1] = {
    status: 'active',
    expires_at: opts.expires_at,
  };
  // Only include `grace_until` when the caller passed it — otherwise we leave
  // the existing value in place.
  const updated = await tx.updateLicense(
    license.id,
    opts.grace_until !== undefined ? { ...patch, grace_until: opts.grace_until } : patch,
  );
  await writeAudit(tx, license, updated, 'license.renewed', now, opts.actor);
  return updated;
}

/**
 * "Tick" the license — persist any time-driven transition that the effective
 * status implies. Call this on a scheduled sweep. Returns the (possibly
 * updated) license.
 *
 * - `active` whose `expires_at` is past and `grace_until` is in the future →
 *   persist `grace`.
 * - `active`/`grace` whose `grace_until` is past → persist `expired`.
 */
export async function tick(
  tx: StorageTx,
  license: License,
  clock: Clock,
  opts: TransitionOptions = {},
): Promise<License> {
  const now = clock.nowIso();
  const target = effectiveStatus(license, now);
  if (target === license.status) return license;
  if (target === 'grace') {
    const updated = await tx.updateLicense(license.id, { status: 'grace' });
    await writeAudit(tx, license, updated, 'license.grace_entered', now, opts.actor);
    return updated;
  }
  if (target === 'expired') {
    const updated = await tx.updateLicense(license.id, { status: 'expired' });
    await writeAudit(tx, license, updated, 'license.expired', now, opts.actor);
    return updated;
  }
  return license;
}

// ---------- internals ----------

function assertNotRevoked(license: License): void {
  if (license.status === 'revoked') throw errors.licenseRevoked();
}

function illegalTransition(from: LicenseStatus, to: LicenseStatus): Error {
  return errors.illegalLifecycleTransition(from, to);
}

async function writeAudit(
  tx: StorageTx,
  prior: License,
  next: License,
  event: string,
  occurredAt: string,
  actor: string | undefined,
): Promise<void> {
  await tx.appendAudit({
    license_id: prior.id,
    scope_id: prior.scope_id,
    actor: actor ?? 'system',
    event,
    prior_state: stateSnapshot(prior),
    new_state: stateSnapshot(next),
    occurred_at: occurredAt,
  });
}

function stateSnapshot(l: License): Readonly<Record<string, JSONValue>> {
  return {
    status: l.status,
    activated_at: l.activated_at,
    expires_at: l.expires_at,
    grace_until: l.grace_until,
  };
}

// Export the type with a self-reference helper the tests may want.
export type { UUIDv7 };
