/**
 * SQLite storage adapter for @licensing/sdk.
 *
 * ## Architecture
 *
 * Backed by `bun:sqlite`'s synchronous API — we wrap every method in `async`
 * so callers see the same Promise-returning surface as the other adapters.
 * SQLite is a single-writer DB, so transactional serialisation is free: we
 * just issue `BEGIN IMMEDIATE; … COMMIT;` and let SQLite block concurrent
 * writers. Nested transactions are rejected (same contract as memory +
 * Postgres).
 *
 * Seat-count correctness comes "for free" — a SQLite write transaction holds
 * an exclusive reserved lock on the DB for its duration, so two concurrent
 * `createUsage` calls inside transactions are serialised by SQLite itself.
 * The unique partial index `license_usages_active_fp_key` covers the
 * duplicate-active-fingerprint race regardless.
 *
 * AuditLog immutability: no mutator methods on this adapter surface AND
 * `BEFORE UPDATE/DELETE` triggers on `audit_logs` raise with an
 * `ImmutableAuditLog` prefix that the error mapper translates. Defence in
 * depth in case a caller reaches the DB via raw SQL.
 *
 * ## Type mapping
 *
 * - `TEXT` columns store ISO-8601 timestamps, JSON strings, UUIDs, enums.
 * - The adapter serialises objects with `JSON.stringify` on write and parses
 *   with `JSON.parse` on read — SQLite does not interpret JSON natively
 *   without the JSON1 extension (which bun:sqlite ships).
 * - Timestamps are stored as canonical ISO strings (already in that form in
 *   the core's `Instant` contract), so no conversion is needed either way.
 *
 * ## Connection pragmas
 *
 * The constructor sets `PRAGMA journal_mode = WAL` and
 * `PRAGMA foreign_keys = ON` on the shared Database instance. Callers may
 * override WAL (e.g. for `:memory:`), but foreign_keys MUST be on — the
 * migration uses `REFERENCES ... ON DELETE RESTRICT` and relies on it.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type {
  AuditLogEntry,
  AuditLogFilter,
  AuditLogInput,
  Clock,
  JSONValue,
  License,
  LicenseFilter,
  LicenseInput,
  LicenseKey,
  LicenseKeyFilter,
  LicenseKeyInput,
  LicenseKeyPatch,
  LicensePatch,
  LicenseScope,
  LicenseScopeFilter,
  LicenseScopeInput,
  LicenseScopePatch,
  LicenseTemplate,
  LicenseTemplateFilter,
  LicenseTemplateInput,
  LicenseTemplatePatch,
  LicenseUsage,
  LicenseUsageFilter,
  LicenseUsageInput,
  LicenseUsagePatch,
  Page,
  PageRequest,
  Storage,
  StorageTx,
  UUIDv7,
} from '../../index.ts';
import { errors, isoFromMs, newUuidV7, type SchemaDescription, systemClock } from '../../index.ts';

import { decodeCursor, encodeCursor } from './cursor.ts';

/** Cast an array of unknown query parameters to bun:sqlite's binding type.
 *  All our params are uuid strings, numbers, bools, or null — valid bindings.
 *  The cast centralises the `as` so call sites stay readable. */
function bind(params: readonly unknown[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}

import { mapSqliteError } from './errors.ts';
import { SQLITE_SCHEMA } from './schema.ts';

export interface SqliteAdapterOptions {
  /** Clock used for UUIDv7 generation + timestamp defaults. */
  readonly clock?: Clock;
  /** Skip `PRAGMA journal_mode = WAL` — useful for `:memory:` DBs where WAL
   *  has no effect anyway. Default false. */
  readonly skipWalPragma?: boolean;
}

// ---------- Mapping helpers ----------

function parseJson(s: unknown): Readonly<Record<string, JSONValue>> {
  if (s === null || s === undefined) return {};
  if (typeof s !== 'string') return s as Readonly<Record<string, JSONValue>>;
  if (s === '') return {};
  return JSON.parse(s) as Readonly<Record<string, JSONValue>>;
}
function parseJsonNullable(s: unknown): Readonly<Record<string, JSONValue>> | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string') return s as Readonly<Record<string, JSONValue>>;
  return JSON.parse(s) as Readonly<Record<string, JSONValue>>;
}
function toJson(v: Readonly<Record<string, JSONValue>>): string {
  return JSON.stringify(v);
}
function toJsonNullable(v: Readonly<Record<string, JSONValue>> | null | undefined): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function mapLicense(r: Record<string, unknown>): License {
  return {
    id: r.id as UUIDv7,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    template_id: (r.template_id as UUIDv7 | null) ?? null,
    licensable_type: r.licensable_type as string,
    licensable_id: r.licensable_id as string,
    license_key: r.license_key as string,
    status: r.status as License['status'],
    max_usages: r.max_usages as number,
    activated_at: (r.activated_at as string | null) ?? null,
    expires_at: (r.expires_at as string | null) ?? null,
    grace_until: (r.grace_until as string | null) ?? null,
    meta: parseJson(r.meta),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapScope(r: Record<string, unknown>): LicenseScope {
  return {
    id: r.id as UUIDv7,
    slug: r.slug as string,
    name: r.name as string,
    meta: parseJson(r.meta),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapTemplate(r: Record<string, unknown>): LicenseTemplate {
  return {
    id: r.id as UUIDv7,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    name: r.name as string,
    max_usages: r.max_usages as number,
    trial_duration_sec: r.trial_duration_sec as number,
    grace_duration_sec: r.grace_duration_sec as number,
    force_online_after_sec: (r.force_online_after_sec as number | null) ?? null,
    entitlements: parseJson(r.entitlements),
    meta: parseJson(r.meta),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapUsage(r: Record<string, unknown>): LicenseUsage {
  return {
    id: r.id as UUIDv7,
    license_id: r.license_id as UUIDv7,
    fingerprint: r.fingerprint as string,
    status: r.status as LicenseUsage['status'],
    registered_at: r.registered_at as string,
    revoked_at: (r.revoked_at as string | null) ?? null,
    client_meta: parseJson(r.client_meta),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapKey(r: Record<string, unknown>): LicenseKey {
  return {
    id: r.id as UUIDv7,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    kid: r.kid as string,
    alg: r.alg as LicenseKey['alg'],
    role: r.role as LicenseKey['role'],
    state: r.state as LicenseKey['state'],
    public_pem: r.public_pem as string,
    private_pem_enc: (r.private_pem_enc as string | null) ?? null,
    rotated_from: (r.rotated_from as UUIDv7 | null) ?? null,
    rotated_at: (r.rotated_at as string | null) ?? null,
    not_before: r.not_before as string,
    not_after: (r.not_after as string | null) ?? null,
    meta: parseJson(r.meta),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapAudit(r: Record<string, unknown>): AuditLogEntry {
  return {
    id: r.id as UUIDv7,
    license_id: (r.license_id as UUIDv7 | null) ?? null,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    actor: r.actor as string,
    event: r.event as string,
    prior_state: parseJsonNullable(r.prior_state),
    new_state: parseJsonNullable(r.new_state),
    occurred_at: r.occurred_at as string,
  };
}

export class SqliteStorage implements Storage {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #inTransaction: boolean;

  constructor(db: Database, opts?: SqliteAdapterOptions);
  constructor(db: Database, opts: SqliteAdapterOptions | undefined, _tx: true);
  constructor(db: Database, opts: SqliteAdapterOptions = {}, tx?: true) {
    this.#db = db;
    this.#clock = opts.clock ?? systemClock;
    this.#inTransaction = tx === true;
    if (!tx) {
      // Only set pragmas on the top-level instance — transaction-nested
      // adapters share the same Database.
      if (!opts.skipWalPragma) {
        try {
          db.run('PRAGMA journal_mode = WAL');
        } catch {
          // In-memory DBs reject WAL; ignore and continue.
        }
      }
      db.run('PRAGMA foreign_keys = ON');
    }
  }

  /** Current-time ISO with microsecond precision. */
  #now(): string {
    return isoFromMs(this.#clock.nowMs());
  }

  // ---------- Licenses ----------

  async createLicense(input: LicenseInput): Promise<License> {
    const id = newUuidV7(this.#clock);
    const now = this.#now();
    try {
      this.#db
        .query(
          `INSERT INTO licenses (
             id, scope_id, template_id, licensable_type, licensable_id,
             license_key, status, max_usages, activated_at, expires_at,
             grace_until, meta, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.scope_id ?? null,
          input.template_id ?? null,
          input.licensable_type,
          input.licensable_id,
          input.license_key,
          input.status,
          input.max_usages,
          input.activated_at ?? null,
          input.expires_at ?? null,
          input.grace_until ?? null,
          toJson(input.meta),
          now,
          now,
        );
      const row = this.#db.query('SELECT * FROM licenses WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.licenseNotFound(id);
      return mapLicense(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getLicense(id: UUIDv7): Promise<License | null> {
    const row = this.#db.query('SELECT * FROM licenses WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapLicense(row) : null;
  }

  async getLicenseByKey(licenseKey: string): Promise<License | null> {
    const row = this.#db
      .query('SELECT * FROM licenses WHERE license_key = ?')
      .get(licenseKey) as Record<string, unknown> | null;
    return row ? mapLicense(row) : null;
  }

  async listLicenses(filter: LicenseFilter, page: PageRequest): Promise<Page<License>> {
    const { where, params } = buildLicenseWhere(filter);
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page);
    const sql = `SELECT * FROM licenses
                 WHERE ${where}${cursorClause}
                 ORDER BY created_at DESC, id DESC
                 ${limitClause}`;
    const rows = this.#db.query(sql).all(...bind([...params, ...cursorParams])) as Record<
      string,
      unknown
    >[];
    return buildPage(rows.map(mapLicense), limit);
  }

  async updateLicense(id: UUIDv7, patch: LicensePatch): Promise<License> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    const now = this.#now();
    try {
      if (setSql === null) {
        this.#db.query('UPDATE licenses SET updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.#db
          .query(`UPDATE licenses SET ${setSql}, updated_at = ? WHERE id = ?`)
          .run(...bind([...values, now, id]));
      }
      const row = this.#db.query('SELECT * FROM licenses WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.licenseNotFound(id);
      return mapLicense(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  // ---------- LicenseScopes ----------

  async createScope(input: LicenseScopeInput): Promise<LicenseScope> {
    const id = newUuidV7(this.#clock);
    const now = this.#now();
    try {
      this.#db
        .query(
          `INSERT INTO license_scopes (id, slug, name, meta, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(id, input.slug, input.name, toJson(input.meta), now, now);
      const row = this.#db.query('SELECT * FROM license_scopes WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      return mapScope(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getScope(id: UUIDv7): Promise<LicenseScope | null> {
    const row = this.#db.query('SELECT * FROM license_scopes WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapScope(row) : null;
  }

  async getScopeBySlug(slug: string): Promise<LicenseScope | null> {
    const row = this.#db.query('SELECT * FROM license_scopes WHERE slug = ?').get(slug) as Record<
      string,
      unknown
    > | null;
    return row ? mapScope(row) : null;
  }

  async listScopes(filter: LicenseScopeFilter, page: PageRequest): Promise<Page<LicenseScope>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.slug !== undefined) {
      where.push(`slug = ?`);
      params.push(filter.slug);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page);
    const rows = this.#db
      .query(
        `SELECT * FROM license_scopes
         WHERE ${where.join(' AND ')}${cursorClause}
         ORDER BY created_at DESC, id DESC
         ${limitClause}`,
      )
      .all(...bind([...params, ...cursorParams])) as Record<string, unknown>[];
    return buildPage(rows.map(mapScope), limit);
  }

  async updateScope(id: UUIDv7, patch: LicenseScopePatch): Promise<LicenseScope> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    const now = this.#now();
    try {
      if (setSql === null) {
        this.#db.query('UPDATE license_scopes SET updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.#db
          .query(`UPDATE license_scopes SET ${setSql}, updated_at = ? WHERE id = ?`)
          .run(...bind([...values, now, id]));
      }
      const row = this.#db.query('SELECT * FROM license_scopes WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.uniqueConstraintViolation('pk', id);
      return mapScope(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  // ---------- LicenseTemplates ----------

  async createTemplate(input: LicenseTemplateInput): Promise<LicenseTemplate> {
    const id = newUuidV7(this.#clock);
    const now = this.#now();
    try {
      this.#db
        .query(
          `INSERT INTO license_templates (
             id, scope_id, name, max_usages, trial_duration_sec, grace_duration_sec,
             force_online_after_sec, entitlements, meta, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.scope_id ?? null,
          input.name,
          input.max_usages,
          input.trial_duration_sec,
          input.grace_duration_sec,
          input.force_online_after_sec ?? null,
          toJson(input.entitlements),
          toJson(input.meta),
          now,
          now,
        );
      const row = this.#db.query('SELECT * FROM license_templates WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      return mapTemplate(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getTemplate(id: UUIDv7): Promise<LicenseTemplate | null> {
    const row = this.#db.query('SELECT * FROM license_templates WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapTemplate(row) : null;
  }

  async listTemplates(
    filter: LicenseTemplateFilter,
    page: PageRequest,
  ): Promise<Page<LicenseTemplate>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.scope_id !== undefined) {
      if (filter.scope_id === null) where.push('scope_id IS NULL');
      else {
        where.push('scope_id = ?');
        params.push(filter.scope_id);
      }
    }
    if (filter.name !== undefined) {
      where.push('name = ?');
      params.push(filter.name);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page);
    const rows = this.#db
      .query(
        `SELECT * FROM license_templates
         WHERE ${where.join(' AND ')}${cursorClause}
         ORDER BY created_at DESC, id DESC
         ${limitClause}`,
      )
      .all(...bind([...params, ...cursorParams])) as Record<string, unknown>[];
    return buildPage(rows.map(mapTemplate), limit);
  }

  async updateTemplate(id: UUIDv7, patch: LicenseTemplatePatch): Promise<LicenseTemplate> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    const now = this.#now();
    try {
      if (setSql === null) {
        this.#db.query('UPDATE license_templates SET updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.#db
          .query(`UPDATE license_templates SET ${setSql}, updated_at = ? WHERE id = ?`)
          .run(...bind([...values, now, id]));
      }
      const row = this.#db.query('SELECT * FROM license_templates WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.uniqueConstraintViolation('pk', id);
      return mapTemplate(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  // ---------- LicenseUsages ----------

  async createUsage(input: LicenseUsageInput): Promise<LicenseUsage> {
    const id = newUuidV7(this.#clock);
    const now = this.#now();
    try {
      this.#db
        .query(
          `INSERT INTO license_usages (
             id, license_id, fingerprint, status, registered_at, revoked_at,
             client_meta, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.license_id,
          input.fingerprint,
          input.status,
          input.registered_at,
          input.revoked_at ?? null,
          toJson(input.client_meta),
          now,
          now,
        );
      const row = this.#db.query('SELECT * FROM license_usages WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      return mapUsage(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getUsage(id: UUIDv7): Promise<LicenseUsage | null> {
    const row = this.#db.query('SELECT * FROM license_usages WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapUsage(row) : null;
  }

  async listUsages(filter: LicenseUsageFilter, page: PageRequest): Promise<Page<LicenseUsage>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.license_id !== undefined) {
      where.push('license_id = ?');
      params.push(filter.license_id);
    }
    if (filter.fingerprint !== undefined) {
      where.push('fingerprint = ?');
      params.push(filter.fingerprint);
    }
    if (filter.status && filter.status.length > 0) {
      const placeholders = filter.status.map(() => '?').join(',');
      where.push(`status IN (${placeholders})`);
      params.push(...filter.status);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page);
    const rows = this.#db
      .query(
        `SELECT * FROM license_usages
         WHERE ${where.join(' AND ')}${cursorClause}
         ORDER BY created_at DESC, id DESC
         ${limitClause}`,
      )
      .all(...bind([...params, ...cursorParams])) as Record<string, unknown>[];
    return buildPage(rows.map(mapUsage), limit);
  }

  async updateUsage(id: UUIDv7, patch: LicenseUsagePatch): Promise<LicenseUsage> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    const now = this.#now();
    try {
      if (setSql === null) {
        this.#db.query('UPDATE license_usages SET updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.#db
          .query(`UPDATE license_usages SET ${setSql}, updated_at = ? WHERE id = ?`)
          .run(...bind([...values, now, id]));
      }
      const row = this.#db.query('SELECT * FROM license_usages WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.uniqueConstraintViolation('pk', id);
      return mapUsage(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  // ---------- LicenseKeys ----------

  async createKey(input: LicenseKeyInput): Promise<LicenseKey> {
    const id = newUuidV7(this.#clock);
    const now = this.#now();
    try {
      this.#db
        .query(
          `INSERT INTO license_keys (
             id, scope_id, kid, alg, role, state, public_pem, private_pem_enc,
             rotated_from, rotated_at, not_before, not_after, meta,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.scope_id ?? null,
          input.kid,
          input.alg,
          input.role,
          input.state,
          input.public_pem,
          input.private_pem_enc ?? null,
          input.rotated_from ?? null,
          input.rotated_at ?? null,
          input.not_before,
          input.not_after ?? null,
          toJson(input.meta),
          now,
          now,
        );
      const row = this.#db.query('SELECT * FROM license_keys WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      return mapKey(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getKey(id: UUIDv7): Promise<LicenseKey | null> {
    const row = this.#db.query('SELECT * FROM license_keys WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapKey(row) : null;
  }

  async getKeyByKid(kid: string): Promise<LicenseKey | null> {
    const row = this.#db.query('SELECT * FROM license_keys WHERE kid = ?').get(kid) as Record<
      string,
      unknown
    > | null;
    return row ? mapKey(row) : null;
  }

  async listKeys(filter: LicenseKeyFilter, page: PageRequest): Promise<Page<LicenseKey>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.scope_id !== undefined) {
      if (filter.scope_id === null) where.push('scope_id IS NULL');
      else {
        where.push('scope_id = ?');
        params.push(filter.scope_id);
      }
    }
    if (filter.kid !== undefined) {
      where.push('kid = ?');
      params.push(filter.kid);
    }
    if (filter.alg !== undefined) {
      where.push('alg = ?');
      params.push(filter.alg);
    }
    if (filter.role !== undefined) {
      where.push('role = ?');
      params.push(filter.role);
    }
    if (filter.state !== undefined) {
      where.push('state = ?');
      params.push(filter.state);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page);
    const rows = this.#db
      .query(
        `SELECT * FROM license_keys
         WHERE ${where.join(' AND ')}${cursorClause}
         ORDER BY created_at DESC, id DESC
         ${limitClause}`,
      )
      .all(...bind([...params, ...cursorParams])) as Record<string, unknown>[];
    return buildPage(rows.map(mapKey), limit);
  }

  async updateKey(id: UUIDv7, patch: LicenseKeyPatch): Promise<LicenseKey> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    const now = this.#now();
    try {
      if (setSql === null) {
        this.#db.query('UPDATE license_keys SET updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.#db
          .query(`UPDATE license_keys SET ${setSql}, updated_at = ? WHERE id = ?`)
          .run(...bind([...values, now, id]));
      }
      const row = this.#db.query('SELECT * FROM license_keys WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      if (!row) throw errors.uniqueConstraintViolation('pk', id);
      return mapKey(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  // ---------- AuditLog ----------

  async appendAudit(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = newUuidV7(this.#clock);
    try {
      this.#db
        .query(
          `INSERT INTO audit_logs (
             id, license_id, scope_id, actor, event, prior_state, new_state, occurred_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.license_id ?? null,
          input.scope_id ?? null,
          input.actor,
          input.event,
          toJsonNullable(input.prior_state ?? null),
          toJsonNullable(input.new_state ?? null),
          input.occurred_at,
        );
      const row = this.#db.query('SELECT * FROM audit_logs WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      return mapAudit(row);
    } catch (e) {
      mapSqliteError(e);
    }
  }

  async getAudit(id: UUIDv7): Promise<AuditLogEntry | null> {
    const row = this.#db.query('SELECT * FROM audit_logs WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapAudit(row) : null;
  }

  async listAudit(filter: AuditLogFilter, page: PageRequest): Promise<Page<AuditLogEntry>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.license_id !== undefined) {
      if (filter.license_id === null) where.push('license_id IS NULL');
      else {
        where.push('license_id = ?');
        params.push(filter.license_id);
      }
    }
    if (filter.scope_id !== undefined) {
      if (filter.scope_id === null) where.push('scope_id IS NULL');
      else {
        where.push('scope_id = ?');
        params.push(filter.scope_id);
      }
    }
    if (filter.event !== undefined) {
      where.push('event = ?');
      params.push(filter.event);
    }
    const limit = Math.max(1, Math.min(page.limit, 500));
    const cursor = decodeCursor(page.cursor);
    let cursorClause = '';
    const cursorParams: unknown[] = [];
    if (cursor) {
      cursorClause = ` AND (occurred_at, id) < (?, ?)`;
      cursorParams.push(cursor.createdAt, cursor.id);
    }
    const rows = this.#db
      .query(
        `SELECT * FROM audit_logs
         WHERE ${where.join(' AND ')}${cursorClause}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ${limit + 1}`,
      )
      .all(...bind([...params, ...cursorParams])) as Record<string, unknown>[];
    const items = rows.slice(0, limit).map(mapAudit);
    const hasMore = rows.length > limit;
    const last = items.at(-1);
    return {
      items,
      cursor: hasMore && last ? encodeCursor({ createdAt: last.occurred_at, id: last.id }) : null,
    };
  }

  // ---------- Transactions & schema ----------

  async withTransaction<T>(fn: (tx: StorageTx) => Promise<T>): Promise<T> {
    if (this.#inTransaction) {
      throw new Error('nested transactions are not supported by @licensing/sdk/storage/sqlite');
    }
    // `BEGIN IMMEDIATE` acquires the RESERVED lock up front so concurrent
    // writers queue at BEGIN rather than mid-tx (avoids SQLITE_BUSY on the
    // first write).
    this.#db.run('BEGIN IMMEDIATE');
    const tx = new SqliteStorage(this.#db, { clock: this.#clock, skipWalPragma: true }, true);
    try {
      const result = await fn(tx);
      this.#db.run('COMMIT');
      return result;
    } catch (err) {
      this.#db.run('ROLLBACK');
      throw err;
    }
  }

  describeSchema(): SchemaDescription {
    return SQLITE_SCHEMA;
  }

  async close(): Promise<void> {
    // Caller-owned: the Database instance is passed in, so we do NOT close
    // it here. If a consumer wants the DB torn down they call db.close().
  }
}

// ---------- SQL helpers ----------

function buildLicenseWhere(filter: LicenseFilter): { where: string; params: unknown[] } {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (filter.scope_id !== undefined) {
    if (filter.scope_id === null) where.push('scope_id IS NULL');
    else {
      where.push('scope_id = ?');
      params.push(filter.scope_id);
    }
  }
  if (filter.status && filter.status.length > 0) {
    const placeholders = filter.status.map(() => '?').join(',');
    where.push(`status IN (${placeholders})`);
    params.push(...filter.status);
  }
  if (filter.licensable_type !== undefined) {
    where.push('licensable_type = ?');
    params.push(filter.licensable_type);
  }
  if (filter.licensable_id !== undefined) {
    where.push('licensable_id = ?');
    params.push(filter.licensable_id);
  }
  if (filter.template_id !== undefined) {
    if (filter.template_id === null) where.push('template_id IS NULL');
    else {
      where.push('template_id = ?');
      params.push(filter.template_id);
    }
  }
  return { where: where.join(' AND '), params };
}

function buildUpdateSet(patch: Record<string, unknown>): {
  setSql: string | null;
  values: unknown[];
} {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // JSON-serialise object values (meta/entitlements/client_meta/prior_state/new_state).
    // Dates/strings/numbers/null pass through.
    const serialised =
      v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    values.push(serialised);
    sets.push(`${k} = ?`);
  }
  if (sets.length === 0) return { setSql: null, values: [] };
  return { setSql: sets.join(', '), values };
}

function buildPagination(page: PageRequest): {
  limitClause: string;
  cursorClause: string;
  cursorParams: unknown[];
  limit: number;
} {
  const limit = Math.max(1, Math.min(page.limit, 500));
  const cursor = decodeCursor(page.cursor);
  if (!cursor) {
    return { limitClause: `LIMIT ${limit + 1}`, cursorClause: '', cursorParams: [], limit };
  }
  return {
    limitClause: `LIMIT ${limit + 1}`,
    cursorClause: ` AND (created_at, id) < (?, ?)`,
    cursorParams: [cursor.createdAt, cursor.id],
    limit,
  };
}

function buildPage<T extends { readonly created_at: string; readonly id: string }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);
  return {
    items,
    cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
