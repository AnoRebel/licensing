/**
 * License creation orchestration.
 *
 * `createLicense()` wraps the storage-level insert with:
 *   - Key generation when omitted (via `generateLicenseKey`).
 *   - Key normalization/validation when explicitly passed.
 *   - An atomic `license.created` audit log row written in the same tx.
 *   - `LicenseKeyConflict` surfacing when the adapter rejects a duplicate.
 *
 * The actual lifecycle transitions (activate, renew, suspend, ...) live in
 * `lifecycle.ts`. This module is just the create-path glue.
 */

import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import { assertLicenseKey, generateLicenseKey, normalizeLicenseKey } from './license-key.ts';
import type { Storage, StorageTx } from './storage/types.ts';
import type { ActorKind, JSONValue, License, LicenseStatus, UUIDv7 } from './types.ts';

export interface CreateLicenseInput {
  readonly scope_id: UUIDv7 | null;
  readonly template_id: UUIDv7 | null;
  readonly licensable_type: string;
  readonly licensable_id: string;
  /** Optional — auto-generated (160-bit Crockford Base32) when omitted. */
  readonly license_key?: string;
  /** Defaults to `'pending'` when omitted. */
  readonly status?: LicenseStatus;
  readonly max_usages: number;
  readonly activated_at?: string | null;
  readonly expires_at?: string | null;
  readonly grace_until?: string | null;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface CreateLicenseOptions {
  /** Actor attribution for the `license.created` audit row. Default `'system'`. */
  readonly actor?: string;
  /**
   * Optional acting principal, carried through to the audit row. When
   * `actorKind` is omitted the adapter derives it from `actor`, so
   * existing callers keep their previous behaviour.
   */
  readonly actorKind?: ActorKind;
  readonly actorId?: string | null;
}

/**
 * Create a license with audit trail, inside a single storage transaction.
 *
 * Status defaults to `'pending'`, the key is generated when the caller
 * didn't pass one, and an audit row of kind `license.created` is written
 * atomically with the row insert.
 */
export async function createLicense(
  storage: Storage,
  clock: Clock,
  input: CreateLicenseInput,
  opts: CreateLicenseOptions = {},
): Promise<License> {
  const license_key =
    input.license_key !== undefined ? assertLicenseKey(input.license_key) : generateLicenseKey();
  const status = input.status ?? 'pending';

  return storage.withTransaction(async (tx) => {
    const created = await tx.createLicense({
      scope_id: input.scope_id,
      template_id: input.template_id,
      licensable_type: input.licensable_type,
      licensable_id: input.licensable_id,
      license_key,
      status,
      max_usages: input.max_usages,
      activated_at: input.activated_at ?? null,
      expires_at: input.expires_at ?? null,
      grace_until: input.grace_until ?? null,
      meta: input.meta ?? {},
    });
    await writeCreatedAudit(tx, created, clock.nowIso(), opts);
    return created;
  });
}

/**
 * Look up a license by its user-facing key, case-insensitively.
 *
 * License keys are emitted uppercase by `generateLicenseKey`, so the stored
 * column is always uppercase Crockford Base32. Users often paste keys in
 * mixed case or with stray whitespace — `normalizeLicenseKey` trims and
 * uppercases before the adapter lookup, and a malformed input (bad shape,
 * I/L/O/U present, etc.) returns null rather than throwing, so callers can
 * treat "not found" and "invalid shape" uniformly. This is the required
 * case-insensitive lookup entrypoint — adapters intentionally do not
 * normalize on their side (they're dumb stores; case-insensitivity is a
 * domain concern).
 */
export async function findLicenseByKey(
  storage: Storage,
  licenseKey: string,
): Promise<License | null> {
  const normalized = normalizeLicenseKey(licenseKey);
  if (normalized === null) return null;
  return storage.getLicenseByKey(normalized);
}

async function writeCreatedAudit(
  tx: StorageTx,
  license: License,
  occurred_at: string,
  opts: CreateLicenseOptions,
): Promise<void> {
  await tx.appendAudit({
    license_id: license.id,
    scope_id: license.scope_id,
    actor: opts.actor ?? 'system',
    ...(opts.actorKind !== undefined ? { actor_kind: opts.actorKind } : {}),
    ...(opts.actorId !== undefined ? { actor_id: opts.actorId } : {}),
    event: 'license.created',
    prior_state: null,
    new_state: {
      status: license.status,
      license_key: license.license_key,
      max_usages: license.max_usages,
      expires_at: license.expires_at,
      grace_until: license.grace_until,
      template_id: license.template_id,
    },
    occurred_at,
  });
}

/** Configures {@link rotateLicenseKey}. */
export interface RotateLicenseKeyOptions {
  readonly actor?: string;
  readonly actorKind?: ActorKind;
  readonly actorId?: string | null;
}

/** Reports what a rotation did. */
export interface RotateLicenseKeyResult {
  readonly license: License;
  /**
   * Seats revoked by the rotation.
   *
   * The prior key is deliberately NOT returned: the caller already held it
   * before rotating, and echoing a just-invalidated secret back through
   * another layer only widens where it can be logged.
   */
  readonly revokedUsageIds: UUIDv7[];
}

/**
 * Issues a fresh `license_key` and revokes every active seat, forcing each
 * device to re-activate with the new key.
 *
 * This is leak response, not routine maintenance. Every copy of the old key
 * already distributed to the customer stops working, so the operator must
 * deliver the new one out of band. Seats are revoked deliberately: a
 * rotation that left existing devices running would not contain a leaked
 * key, which is the only reason to rotate.
 *
 * `license_key` is otherwise immutable — `LicensePatch.license_key` exists
 * for this function alone and the admin update route cannot reach it, so
 * the mutation stays explicit and auditable.
 *
 * Revoked licences are refused: revoked is terminal, and handing out a new
 * key for a dead licence would imply it could be used.
 *
 * Mirrors Go's `RotateLicenseKey`.
 */
export async function rotateLicenseKey(
  storage: Storage,
  clock: Clock,
  licenseId: UUIDv7,
  opts: RotateLicenseKeyOptions = {},
): Promise<RotateLicenseKeyResult> {
  return storage.withTransaction(async (tx) => {
    const license = await tx.getLicense(licenseId);
    if (license === null) throw errors.licenseNotFound(licenseId);
    if (license.status === 'revoked') {
      // Terminal state: a new key would imply the licence could still be used.
      throw errors.licenseRevoked();
    }

    const updated = await tx.updateLicense(license.id, {
      license_key: generateLicenseKey(),
    });

    const now = clock.nowIso();
    const revokedUsageIds: UUIDv7[] = [];

    // Revoke every live seat inside the same transaction as the key change,
    // so a partial rotation cannot exist: either the key is new and the
    // seats are gone, or neither happened.
    let cursor: string | null | undefined;
    while (true) {
      const page = await tx.listUsages(
        { license_id: license.id, status: ['active'] },
        cursor === null || cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
      );
      for (const usage of page.items) {
        await tx.updateUsage(usage.id, { status: 'revoked', revoked_at: now });
        revokedUsageIds.push(usage.id);
      }
      if (page.cursor === null) break;
      cursor = page.cursor;
    }

    // One audit row for the rotation. Key values are deliberately absent
    // from both states — writing the new key into an append-only log that
    // operators and support staff can read would leak the very secret the
    // rotation exists to protect.
    await tx.appendAudit({
      license_id: license.id,
      scope_id: license.scope_id,
      actor: opts.actor ?? 'system',
      ...(opts.actorKind !== undefined ? { actor_kind: opts.actorKind } : {}),
      ...(opts.actorId !== undefined ? { actor_id: opts.actorId } : {}),
      event: 'license.key_rotated',
      prior_state: { active_usages: revokedUsageIds.length },
      new_state: { active_usages: 0, usages_revoked: revokedUsageIds.length },
      occurred_at: now,
    });

    return { license: updated, revokedUsageIds };
  });
}
