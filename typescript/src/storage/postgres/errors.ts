/**
 * Postgres error → `@licensing/sdk` error mapping.
 *
 * The core's error taxonomy is storage-agnostic; this module translates
 * Postgres's SQLSTATE codes + constraint-name clues into the core's
 * domain-typed errors. Every place the adapter catches a driver error
 * MUST route it through `mapPgError` before re-throwing, so consumers see
 * a uniform error surface regardless of backend.
 *
 * SQLSTATE references: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

import { errors } from '../../index.ts';

export interface PgError {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
  readonly detail?: string;
}

/** Heuristic: is this thing shaped like a pg driver error? */
function isPgError(e: unknown): e is PgError {
  return typeof e === 'object' && e !== null && 'message' in e;
}

/** Map a pg driver error to a core domain error where possible. Unmatched
 *  errors are re-thrown untouched — they're almost certainly bugs in the
 *  adapter's SQL, and swallowing them would hide the root cause. */
export function mapPgError(e: unknown): never {
  if (!isPgError(e)) throw e;

  // Unique violation (23505). The constraint name tells us WHICH uniqueness
  // was violated.
  if (e.code === '23505' && e.constraint) {
    const c = e.constraint;
    if (c === 'licenses_license_key_key') {
      // Canonical error for duplicate license keys.
      const match = /\(license_key\)=\(([^)]+)\)/.exec(e.detail ?? '');
      const key = match?.[1] ?? 'unknown';
      throw errors.licenseKeyConflict(key);
    }
    if (c === 'licenses_scoped_triple_key' || c === 'licenses_global_pair_key') {
      throw errors.uniqueConstraintViolation(
        'licensable_scope',
        e.detail ?? '(licensable_type, licensable_id, scope_id)',
      );
    }
    if (c === 'license_scopes_slug_key') {
      const match = /\(slug\)=\(([^)]+)\)/.exec(e.detail ?? '');
      throw errors.uniqueConstraintViolation('slug', match?.[1] ?? 'unknown');
    }
    if (c === 'license_templates_scope_name_key' || c === 'license_templates_global_name_key') {
      throw errors.uniqueConstraintViolation('scope_name', e.detail ?? '(scope_id, name)');
    }
    if (c === 'license_usages_active_fp_key') {
      throw errors.uniqueConstraintViolation(
        'license_fingerprint_active',
        e.detail ?? '(license_id, fingerprint)',
      );
    }
    if (c === 'license_keys_kid_key') {
      const match = /\(kid\)=\(([^)]+)\)/.exec(e.detail ?? '');
      throw errors.uniqueConstraintViolation('kid', match?.[1] ?? 'unknown');
    }
    if (
      c === 'license_keys_active_signing_scoped_key' ||
      c === 'license_keys_active_signing_global_key'
    ) {
      throw errors.uniqueConstraintViolation(
        'scope_active_signing',
        e.detail ?? '(scope_id, role, state)',
      );
    }
    // Unknown constraint — surface it generically but preserve the name for
    // debugging.
    throw errors.uniqueConstraintViolation(c, e.detail ?? '');
  }

  // AuditLog immutability trigger — migration raises P0001 with this prefix.
  if (e.code === 'P0001' && /ImmutableAuditLog/i.test(e.message)) {
    throw errors.immutableAuditLog();
  }

  // Not a known mapping — rethrow the original so we don't silently eat
  // schema bugs or driver errors.
  throw e;
}
