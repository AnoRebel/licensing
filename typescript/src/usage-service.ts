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
import type { ActorKind, Fingerprint, JSONValue, License, LicenseUsage, UUIDv7 } from './types.ts';

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
  /**
   * Optional acting principal, carried through to the audit row. When
   * `actorKind` is omitted the adapter derives it from `actor`, so
   * existing callers keep their previous behaviour.
   */
  readonly actorKind?: ActorKind;
  readonly actorId?: string | null;
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
      ...(opts.actorKind !== undefined ? { actor_kind: opts.actorKind } : {}),
      ...(opts.actorId !== undefined ? { actor_id: opts.actorId } : {}),
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

// ---------- inactivity sweep ----------

/** Configures {@link sweepInactiveUsages}. */
export interface SweepInactiveUsagesOptions {
  /**
   * How long a seat may go without a heartbeat before it is considered
   * abandoned, in seconds. Required; must be positive.
   */
  readonly inactiveForSec: number;
  /** Limit the sweep to a single license. Omit to sweep all. */
  readonly licenseId?: UUIDv7;
  /** Report what would be revoked without writing anything. */
  readonly dryRun?: boolean;
  /** Attributes the audit rows. Defaults to `"system"`. */
  readonly actor?: string;
}

/** Reports what a sweep did (or would do). */
export interface SweepInactiveUsagesResult {
  /** Number of active usages examined. */
  readonly scanned: number;
  /** Usage ids past the threshold. Populated in both dry-run and live mode. */
  readonly stale: UUIDv7[];
  /** Usage ids actually revoked. Empty on a dry run. */
  readonly revoked: UUIDv7[];
}

/**
 * Revokes active seats whose last heartbeat is older than
 * `inactiveForSec`, freeing them on a `max_usages`-constrained license.
 *
 * Seat reclamation is deliberately explicit rather than implied by a stale
 * heartbeat at verification time: silently dropping a seat mid-session
 * would surprise a user whose machine merely slept. A sweep is an operator
 * action, auditable and dry-runnable.
 *
 * Each revocation goes through {@link revokeUsage}, so it emits the same
 * `usage.revoked` audit row as an admin-initiated revoke — a sweep leaves
 * no differently-shaped history.
 *
 * Mirrors Go's `SweepInactiveUsages`.
 */
export async function sweepInactiveUsages(
  storage: Storage,
  clock: Clock,
  opts: SweepInactiveUsagesOptions,
): Promise<SweepInactiveUsagesResult> {
  // Programmer misuse rather than a domain condition, so a plain Error
  // instead of a coded licensing error the caller might try to handle.
  if (!(opts.inactiveForSec > 0)) {
    throw new Error(
      `licensing: sweepInactiveUsages requires a positive inactiveForSec, got ${opts.inactiveForSec}`,
    );
  }
  const nowMs = Date.parse(clock.nowIso());
  if (Number.isNaN(nowMs)) {
    throw new Error(`licensing: clock returned an unparseable instant "${clock.nowIso()}"`);
  }
  const cutoffMs = nowMs - opts.inactiveForSec * 1000;

  const stale: UUIDv7[] = [];
  let scanned = 0;

  // Collect first, mutate after: revoking while paging the same list would
  // shift the cursor under us.
  await storage.withTransaction(async (tx) => {
    let cursor: string | null | undefined;
    while (true) {
      const page = await tx.listUsages(
        {
          ...(opts.licenseId !== undefined ? { license_id: opts.licenseId } : {}),
          status: ['active'],
        },
        cursor === null || cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
      );
      for (const row of page.items) {
        scanned++;
        const seenMs = Date.parse(row.last_seen_at);
        // An unparseable timestamp is a data defect, not a reason to revoke
        // a seat — skip rather than guess.
        if (Number.isNaN(seenMs)) continue;
        if (seenMs < cutoffMs) stale.push(row.id);
      }
      if (page.cursor === null) return;
      cursor = page.cursor;
    }
  });

  if (opts.dryRun === true) {
    return { scanned, stale, revoked: [] };
  }

  const revoked: UUIDv7[] = [];
  for (const id of stale) {
    await revokeUsage(storage, clock, id, opts.actor === undefined ? {} : { actor: opts.actor });
    revoked.push(id);
  }
  return { scanned, stale, revoked };
}
