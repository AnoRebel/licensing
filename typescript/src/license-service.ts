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

import type { Clock } from './id.ts';
import { assertLicenseKey, generateLicenseKey, normalizeLicenseKey } from './license-key.ts';
import type { Storage, StorageTx } from './storage/types.ts';
import type { JSONValue, License, LicenseStatus, UUIDv7 } from './types.ts';

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
    await writeCreatedAudit(tx, created, clock.nowIso(), opts.actor);
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
  actor: string | undefined,
): Promise<void> {
  await tx.appendAudit({
    license_id: license.id,
    scope_id: license.scope_id,
    actor: actor ?? 'system',
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
