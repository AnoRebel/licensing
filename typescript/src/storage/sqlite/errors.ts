/**
 * SQLite error → `@anorebel/licensing` error mapping.
 *
 * bun:sqlite throws `SQLiteError` with a `code` like `SQLITE_CONSTRAINT_UNIQUE`
 * and a message naming the index (`UNIQUE constraint failed: licenses.license_key`).
 * This module parses that shape and translates into the core's storage-agnostic
 * error taxonomy.
 *
 * SQLite error code references:
 *   https://www.sqlite.org/rescode.html
 */

import { errors } from '../../index.ts';

export interface SqliteError {
  readonly code?: string;
  readonly message: string;
}

function isSqliteError(e: unknown): e is SqliteError {
  return typeof e === 'object' && e !== null && 'message' in e;
}

/** Parse `UNIQUE constraint failed: licenses.license_key` → `'license_key'`.
 *  For composite indexes SQLite reports `table.col1, table.col2` — we join on
 *  `+` to produce a constraint-name-like string the mapper can match. */
function parseUniqueFailure(msg: string): { table: string; columns: readonly string[] } | null {
  const m = /UNIQUE constraint failed:\s*(.+)/i.exec(msg);
  if (!m?.[1]) return null;
  const pairs = m[1].split(',').map((s) => s.trim());
  const parts: { table?: string; column: string }[] = [];
  for (const p of pairs) {
    const dot = p.indexOf('.');
    if (dot < 0) return null;
    parts.push({ table: p.slice(0, dot), column: p.slice(dot + 1) });
  }
  const table = parts[0]?.table ?? '';
  return { table, columns: parts.map((x) => x.column) };
}

/** Guess a constraint "name" from the table + column tuple that SQLite
 *  mentioned in its error. We keep the adapter's constraint names stable
 *  across backends so `mapPgError` and `mapSqliteError` both emit the same
 *  `errors.uniqueConstraintViolation('<name>', ...)`. */
function nameConstraint(table: string, columns: readonly string[]): string | null {
  const key = `${table}:${columns.join(',')}`;
  // biome-ignore format: compact lookup table
  const map: Record<string, string> = {
    'licenses:license_key': 'licenses_license_key_key',
    'licenses:licensable_type,licensable_id,scope_id': 'licenses_scoped_triple_key',
    'licenses:licensable_type,licensable_id': 'licenses_global_pair_key',
    'license_scopes:slug': 'license_scopes_slug_key',
    'license_templates:scope_id,name': 'license_templates_scope_name_key',
    'license_templates:name': 'license_templates_global_name_key',
    'license_usages:license_id,fingerprint': 'license_usages_active_fp_key',
    'license_keys:kid': 'license_keys_kid_key',
    'license_keys:scope_id': 'license_keys_active_signing_scoped_key',
    'license_keys:role': 'license_keys_active_signing_global_key',
  };
  return map[key] ?? null;
}

/** Map a SQLiteError to a core domain error where possible. Unmatched errors
 *  are re-thrown untouched. */
export function mapSqliteError(e: unknown): never {
  if (!isSqliteError(e)) throw e;

  // UNIQUE constraint failures.
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message)) {
    const parsed = parseUniqueFailure(e.message);
    if (parsed) {
      const constraint = nameConstraint(parsed.table, parsed.columns);
      if (constraint === 'licenses_license_key_key') {
        throw errors.licenseKeyConflict('unknown');
      }
      if (
        constraint === 'licenses_scoped_triple_key' ||
        constraint === 'licenses_global_pair_key'
      ) {
        throw errors.uniqueConstraintViolation('licensable_scope', parsed.columns.join(','));
      }
      if (constraint === 'license_scopes_slug_key') {
        throw errors.uniqueConstraintViolation('slug', 'unknown');
      }
      if (
        constraint === 'license_templates_scope_name_key' ||
        constraint === 'license_templates_global_name_key'
      ) {
        throw errors.uniqueConstraintViolation('scope_name', parsed.columns.join(','));
      }
      if (constraint === 'license_usages_active_fp_key') {
        throw errors.uniqueConstraintViolation(
          'license_fingerprint_active',
          parsed.columns.join(','),
        );
      }
      if (constraint === 'license_keys_kid_key') {
        throw errors.uniqueConstraintViolation('kid', 'unknown');
      }
      if (
        constraint === 'license_keys_active_signing_scoped_key' ||
        constraint === 'license_keys_active_signing_global_key'
      ) {
        throw errors.uniqueConstraintViolation('scope_active_signing', parsed.columns.join(','));
      }
      // Unknown constraint — surface generically.
      throw errors.uniqueConstraintViolation(
        constraint ?? `${parsed.table}.${parsed.columns.join(',')}`,
        parsed.columns.join(','),
      );
    }
  }

  // AuditLog immutability trigger: RAISE(ABORT, 'ImmutableAuditLog: ...').
  if (/ImmutableAuditLog/i.test(e.message)) {
    throw errors.immutableAuditLog();
  }

  // Not a known mapping — rethrow untouched so we don't hide schema bugs or
  // driver errors.
  throw e;
}
