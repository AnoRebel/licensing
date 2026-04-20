/**
 * LicenseTemplate CRUD + template-backed license creation.
 *
 * Two creation paths are supported:
 *
 *   - No-overrides: copies template defaults onto the new license and sets
 *     `template_id` on the row.
 *   - Caller overrides win: explicit fields on the create call beat the
 *     template's defaults, field-by-field.
 *
 * Design choices (called out because future callers may assume otherwise):
 *
 *   1. `entitlements` lives on the template, not on the license. We copy it
 *      onto `license.meta.entitlements` at creation time as a snapshot so
 *      token issuance can embed the entitlements map without joining the
 *      template later, and subsequent edits to the template do NOT
 *      retroactively rewrite outstanding licenses. Callers who want live
 *      template resolution can read through `license.template_id` instead.
 *
 *   2. `trial_duration_sec` drives `expires_at`: if the caller doesn't pass
 *      an explicit `expires_at` AND the template has a positive
 *      `trial_duration_sec`, we compute `expires_at = now + trial_duration`.
 *      A template value of `0` means "no trial — caller must set expires_at
 *      explicitly or leave it null". A caller-supplied explicit `null`
 *      short-circuits: we honor the explicit null, don't auto-compute.
 *
 *   3. `grace_duration_sec` drives `grace_until` only when `expires_at` is
 *      set: `grace_until = expires_at + grace_duration`. Same explicit-null
 *      short-circuit applies.
 *
 *   4. `scope_id` is inherited from the template unless the caller
 *      overrides. A template with `scope_id = null` ("global") becomes a
 *      license with `scope_id = null` unless the caller pins a scope on
 *      the create call.
 */

import { errors } from './errors.ts';
import type { Clock } from './id.ts';
import {
  type CreateLicenseInput,
  type CreateLicenseOptions,
  createLicense,
} from './license-service.ts';
import type { Page, Storage } from './storage/types.ts';
import type { JSONValue, License, LicenseStatus, LicenseTemplate, UUIDv7 } from './types.ts';

// ---------- createTemplate ----------

export interface CreateTemplateInput {
  readonly scope_id: UUIDv7 | null;
  readonly name: string;
  readonly max_usages: number;
  readonly trial_duration_sec: number;
  readonly grace_duration_sec: number;
  readonly force_online_after_sec: number | null;
  readonly entitlements?: Readonly<Record<string, JSONValue>>;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface CreateTemplateOptions {
  readonly actor?: string;
}

/**
 * Persist a new template and write a `template.created` audit row inside
 * one transaction. Templates have no unique natural key beyond `(scope_id,
 * name)` which the adapter enforces via its own unique constraint; we don't
 * pre-check here because duplicate-name collisions are rare and the
 * adapter error (`UniqueConstraintViolation`) already carries enough detail.
 */
export async function createTemplate(
  storage: Storage,
  clock: Clock,
  input: CreateTemplateInput,
  opts: CreateTemplateOptions = {},
): Promise<LicenseTemplate> {
  if (input.max_usages < 1) {
    throw errors.fingerprintRejected(`template.max_usages must be >= 1 (got ${input.max_usages})`);
  }
  if (input.trial_duration_sec < 0) {
    throw errors.fingerprintRejected(
      `template.trial_duration_sec must be >= 0 (got ${input.trial_duration_sec})`,
    );
  }
  if (input.grace_duration_sec < 0) {
    throw errors.fingerprintRejected(
      `template.grace_duration_sec must be >= 0 (got ${input.grace_duration_sec})`,
    );
  }
  return storage.withTransaction(async (tx) => {
    const template = await tx.createTemplate({
      scope_id: input.scope_id,
      name: input.name,
      max_usages: input.max_usages,
      trial_duration_sec: input.trial_duration_sec,
      grace_duration_sec: input.grace_duration_sec,
      force_online_after_sec: input.force_online_after_sec,
      entitlements: input.entitlements ?? {},
      meta: input.meta ?? {},
    });
    await tx.appendAudit({
      license_id: null,
      scope_id: template.scope_id,
      actor: opts.actor ?? 'system',
      event: 'template.created',
      prior_state: null,
      new_state: {
        template_id: template.id,
        name: template.name,
        max_usages: template.max_usages,
        trial_duration_sec: template.trial_duration_sec,
        grace_duration_sec: template.grace_duration_sec,
      },
      occurred_at: clock.nowIso(),
    });
    return template;
  });
}

/** Thin passthrough; kept for API symmetry with `createTemplate`. */
export async function listTemplates(
  storage: Storage,
  filter: { scope_id?: UUIDv7 | null; name?: string } = {},
  page: { limit?: number; cursor?: string | null } = {},
): Promise<Page<LicenseTemplate>> {
  return storage.listTemplates(filter, {
    limit: page.limit ?? 50,
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
  });
}

// ---------- createLicenseFromTemplate ----------

/** Distinguishes "caller omitted field" from "caller explicitly set null". */
const UNSET: unique symbol = Symbol('unset');
type Unset = typeof UNSET;

export interface CreateLicenseFromTemplateInput {
  readonly template_id: UUIDv7;
  readonly licensable_type: string;
  readonly licensable_id: string;
  /** Overrides. Any field omitted here inherits from the template (or from
   *  `createLicense` defaults, e.g. `status = 'pending'`). To explicitly
   *  disable a computed default (e.g. "no trial expiry"), pass `null`. */
  readonly scope_id?: UUIDv7 | null | Unset;
  readonly license_key?: string;
  readonly status?: LicenseStatus;
  readonly max_usages?: number;
  readonly expires_at?: string | null | Unset;
  readonly grace_until?: string | null | Unset;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

/**
 * Build a new license using `template_id`'s defaults, with field-level
 * overrides from the caller. Delegates to `createLicense` so the created
 * row still flows through audit logging.
 *
 * Returns the fully-resolved license; the caller doesn't need to re-read
 * the row.
 */
export async function createLicenseFromTemplate(
  storage: Storage,
  clock: Clock,
  input: CreateLicenseFromTemplateInput,
  opts: CreateLicenseOptions = {},
): Promise<License> {
  const template = await storage.getTemplate(input.template_id);
  if (template === null) {
    throw errors.fingerprintRejected(`template not found: ${input.template_id}`);
  }

  // Resolve fields in spec order: template default → caller override.
  const scope_id = isUnset(input.scope_id) ? template.scope_id : input.scope_id;
  const max_usages = input.max_usages ?? template.max_usages;

  // Trial/grace computation. Only applied when the caller left `expires_at`
  // unset — explicit `null` is honored as "no expiry" and short-circuits.
  const now = clock.nowIso();
  const expires_at = isUnset(input.expires_at)
    ? computeExpiresAt(now, template.trial_duration_sec)
    : input.expires_at;
  const grace_until = isUnset(input.grace_until)
    ? computeGraceUntil(expires_at, template.grace_duration_sec)
    : input.grace_until;

  // Snapshot entitlements into license.meta at creation time; subsequent
  // edits to the template MUST NOT rewrite outstanding licenses.
  const mergedMeta: Readonly<Record<string, JSONValue>> = {
    ...(Object.keys(template.entitlements).length > 0
      ? { entitlements: template.entitlements as JSONValue }
      : {}),
    ...(template.force_online_after_sec !== null
      ? { force_online_after_sec: template.force_online_after_sec }
      : {}),
    ...(input.meta ?? {}),
  };

  const createInput: CreateLicenseInput = {
    scope_id,
    template_id: template.id,
    licensable_type: input.licensable_type,
    licensable_id: input.licensable_id,
    max_usages,
    expires_at,
    grace_until,
    meta: mergedMeta,
    ...(input.license_key !== undefined ? { license_key: input.license_key } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };

  return createLicense(storage, clock, createInput, opts);
}

// ---------- internals ----------

function isUnset<T>(value: T | Unset | undefined): value is Unset | undefined {
  return value === undefined || value === UNSET;
}

function computeExpiresAt(now: string, trial_duration_sec: number): string | null {
  if (trial_duration_sec <= 0) return null;
  const ms = Date.parse(now) + trial_duration_sec * 1000;
  // Match the `YYYY-MM-DDTHH:MM:SS.ffffffZ` 6-digit microsecond format used
  // elsewhere: `isoFromMs`-compatible but we only need millisecond precision
  // for trial arithmetic. Right-pad with 3 zeros to hit the 6-digit width.
  return `${new Date(ms).toISOString().slice(0, -1)}000Z`;
}

function computeGraceUntil(expires_at: string | null, grace_duration_sec: number): string | null {
  if (expires_at === null || grace_duration_sec <= 0) return null;
  const ms = Date.parse(expires_at) + grace_duration_sec * 1000;
  return `${new Date(ms).toISOString().slice(0, -1)}000Z`;
}
