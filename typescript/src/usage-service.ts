/**
 * Usage (seat) registration and revocation.
 *
 * Seat enforcement via LicenseUsage, plus the "Activating a pending license"
 * transition (first successful registerUsage flips the license from `pending`
 * to `active`).
 *
 * Semantics (enforced atomically inside a single storage transaction):
 *
 *   1. Re-register by same fingerprint is idempotent — returns the existing
 *      active usage without creating a new row. Matches
 *      `PHP UsageRegistrarService::register → $existingUsage->heartbeat()`.
 *
 *   2. When active seat count < max_usages, create a new `active` usage row.
 *      If this is the license's first usage AND the license is `pending`,
 *      atomically promote it to `active` and fire the `license.activated`
 *      audit row.
 *
 *   3. When active seat count == max_usages, throw `SeatLimitExceeded`; the
 *      adapter rolls back — no usage row created. We choose the Reject
 *      policy; the PHP ref offers auto-replace-oldest behind a config flag,
 *      which we do not expose.
 *
 *   4. Usable-status guard: the license must be in `active` or `pending`
 *      when registering. `suspended` → `LicenseSuspended`, `revoked` →
 *      `LicenseRevoked`, `expired` → `LicenseExpired`. This mirrors the PHP
 *      `canRegister()` → `isUsable()` check.
 *
 * `revokeUsage` is the inverse: flips an active usage to `revoked`, writes
 * an audit row, and frees the seat for the next caller.
 */

import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import { activate } from './lifecycle.ts';
import type { Storage, StorageTx } from './storage/types.ts';
import type { Fingerprint, JSONValue, License, LicenseUsage, UUIDv7 } from './types.ts';

export interface RegisterUsageInput {
  readonly license_id: UUIDv7;
  readonly fingerprint: Fingerprint;
  readonly client_meta?: Readonly<Record<string, JSONValue>>;
}

export interface RegisterUsageOptions {
  /** Actor attribution for any audit rows written. Default `'system'`. */
  readonly actor?: string;
}

export interface RegisterUsageResult {
  /** The usage row (new or existing). */
  readonly usage: LicenseUsage;
  /** The license row, possibly flipped from `pending` → `active`. */
  readonly license: License;
  /** True when this call created a new usage; false on idempotent re-register. */
  readonly created: boolean;
}

/**
 * Register (or re-register) a usage against a license. Idempotent on
 * fingerprint. Atomic: all reads, writes, and audit rows happen inside a
 * single `withTransaction`.
 */
export async function registerUsage(
  storage: Storage,
  clock: Clock,
  input: RegisterUsageInput,
  opts: RegisterUsageOptions = {},
): Promise<RegisterUsageResult> {
  return storage.withTransaction(async (tx) => {
    const license = await tx.getLicense(input.license_id);
    if (license === null) throw errors.licenseNotFound(input.license_id);

    assertUsable(license);

    // 1. Idempotent re-register path.
    const existing = await findActiveUsage(tx, input.license_id, input.fingerprint);
    if (existing !== null) {
      return { usage: existing, license, created: false };
    }

    // 2. Seat-check: count active usages *inside the tx*. Postgres/SQLite
    //    hold a write lock at this point (FOR UPDATE / BEGIN IMMEDIATE), so
    //    two racing registrations can't both pass this check.
    const activeCount = await countActiveUsages(tx, input.license_id);
    if (activeCount >= license.max_usages) {
      throw errors.seatLimitExceeded(license.max_usages, activeCount);
    }

    // 3. Insert the usage row.
    const now = clock.nowIso();
    const usage = await tx.createUsage({
      license_id: input.license_id,
      fingerprint: input.fingerprint,
      status: 'active',
      registered_at: now,
      revoked_at: null,
      client_meta: input.client_meta ?? {},
    });
    await tx.appendAudit({
      license_id: license.id,
      scope_id: license.scope_id,
      actor: opts.actor ?? 'system',
      event: 'usage.registered',
      prior_state: null,
      new_state: {
        usage_id: usage.id,
        fingerprint: usage.fingerprint,
        active_count: activeCount + 1,
      },
      occurred_at: now,
    });

    // 4. First successful register on a `pending` license transitions it to
    //    `active`. This is a required side effect, not optional.
    let finalLicense = license;
    if (license.status === 'pending') {
      finalLicense = await activate(tx, license, clock, opts);
    }

    return { usage, license: finalLicense, created: true };
  });
}

export interface RevokeUsageOptions {
  readonly actor?: string;
}

/** Revoke an active usage row. No-op if already revoked. */
export async function revokeUsage(
  storage: Storage,
  clock: Clock,
  usageId: UUIDv7,
  opts: RevokeUsageOptions = {},
): Promise<LicenseUsage> {
  return storage.withTransaction(async (tx) => {
    const usage = await tx.getUsage(usageId);
    if (usage === null) {
      throw errors.fingerprintRejected(`usage not found: ${usageId}`);
    }
    if (usage.status === 'revoked') return usage;
    const now = clock.nowIso();
    const updated = await tx.updateUsage(usageId, {
      status: 'revoked',
      revoked_at: now,
    });
    // Audit via the owning license so the event is discoverable by
    // `listAudit({ license_id })`.
    const license = await tx.getLicense(usage.license_id);
    await tx.appendAudit({
      license_id: usage.license_id,
      scope_id: license?.scope_id ?? null,
      actor: opts.actor ?? 'system',
      event: 'usage.revoked',
      prior_state: { status: 'active', fingerprint: usage.fingerprint },
      new_state: { status: 'revoked', fingerprint: usage.fingerprint },
      occurred_at: now,
    });
    return updated;
  });
}

// ---------- internals ----------

function assertUsable(license: License): void {
  switch (license.status) {
    case 'active':
    case 'pending':
    case 'grace':
      return;
    case 'suspended':
      throw errors.licenseSuspended();
    case 'revoked':
      throw errors.licenseRevoked();
    case 'expired':
      throw errors.licenseExpired();
  }
}

/**
 * Find an active usage for (license_id, fingerprint). Walks list pages until
 * found or exhausted. For realistic seat counts (tens, not thousands) this
 * runs in a single page.
 */
async function findActiveUsage(
  tx: StorageTx,
  license_id: UUIDv7,
  fingerprint: Fingerprint,
): Promise<LicenseUsage | null> {
  let cursor: string | null | undefined;
  while (true) {
    const page = await tx.listUsages(
      { license_id, fingerprint, status: ['active'] },
      cursor === null || cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
    );
    for (const row of page.items) {
      if (row.fingerprint === fingerprint) return row;
    }
    if (page.cursor === null) return null;
    cursor = page.cursor;
  }
}

/** Count active usages for a license. Walks pages. */
async function countActiveUsages(tx: StorageTx, license_id: UUIDv7): Promise<number> {
  let count = 0;
  let cursor: string | null | undefined;
  while (true) {
    const page = await tx.listUsages(
      { license_id, status: ['active'] },
      cursor === null || cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
    );
    count += page.items.length;
    if (page.cursor === null) return count;
    cursor = page.cursor;
  }
}
