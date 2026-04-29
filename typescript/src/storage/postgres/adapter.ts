/**
 * Postgres storage adapter for @anorebel/licensing.
 *
 * ## Architecture
 *
 * The adapter accepts either a `pg.Pool` (for non-transactional reads/writes)
 * or is bound to a `pg.PoolClient` (inside a transaction). Calling
 * `withTransaction(fn)` checks out a client, issues `BEGIN`, hands `fn` a
 * `PostgresStorage` bound to that client, and `COMMIT`s on success or
 * `ROLLBACK`s on any thrown error. Nested transactions are rejected — the
 * memory adapter behaves the same way, and Postgres savepoint plumbing would
 * drift from that contract.
 *
 * Seat-count correctness under concurrent activation is delivered by
 * `SELECT ... FOR UPDATE` inside `createUsage`: the row lock on the parent
 * license row serializes concurrent registration attempts so only one tx
 * can observe `active_count == max_usages - 1` and commit.
 *
 * AuditLog immutability is enforced by the migration-installed trigger; the
 * adapter has no `update*Audit`/`delete*Audit` methods at all (same as memory),
 * so the trigger only fires for callers reaching into the table via raw SQL.
 *
 * ## Type mapping
 *
 * - `jsonb`         → unchanged; pg returns already-parsed JS objects.
 * - `timestamptz`   → pg returns `Date`; we format to ISO microsecond strings
 *                     to match the core's `Instant` contract.
 * - `uuid`          → string, unchanged.
 * - `text`, `integer` → string/number, unchanged.
 *
 * The core's `isoFromMs` formatter guarantees 6-digit fractional seconds.
 * `Date` objects from pg only carry millisecond precision, which is fine —
 * we pad with `000` via `isoFromMs`. Downstream consumers rely on lexical
 * ordering of the string form for cursor pagination, so we must NEVER hand
 * out a `Date` directly.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  AuditLogEntry,
  AuditLogFilter,
  AuditLogInput,
  Clock,
  FindByLicensableQuery,
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
  TrialIssuance,
  TrialIssuanceInput,
  TrialIssuanceLookup,
  UUIDv7,
} from '../../index.ts';
import { errors, isoFromMs, newUuidV7, type SchemaDescription, systemClock } from '../../index.ts';

import { decodeCursor, encodeCursor } from './cursor.ts';
import { mapPgError } from './errors.ts';
import { POSTGRES_SCHEMA } from './schema.ts';

/** Union of the two connection shapes the adapter can run against — a pool
 *  (checks out a client per statement) or a client (one tx, re-used). */
type Queryable = Pool | PoolClient;

/**
 * Walk the template parent chain starting at `startParent` and return the
 * visited ids if `forbidden` appears. Null means "no cycle". Used by
 * updateTemplate to reject re-parenting that would form a loop.
 */
async function walkPgParentChain(
  q: Queryable,
  startParent: UUIDv7,
  forbidden: UUIDv7,
): Promise<readonly UUIDv7[] | null> {
  const visited: UUIDv7[] = [];
  let cursor: UUIDv7 | null = startParent;
  let hops = 0;
  while (cursor !== null && hops < 64) {
    visited.push(cursor);
    if (cursor === forbidden) return visited;
    // Inline the query type via cast — pg's overloads make tsc balk on
    // generic arguments inside a recursive let-narrowing loop.
    const res = (await q.query('SELECT parent_id FROM license_templates WHERE id = $1', [
      cursor,
    ])) as { rows: Array<Record<string, unknown>> };
    const row = res.rows[0];
    if (!row) return null;
    cursor = (row.parent_id as UUIDv7 | null) ?? null;
    hops++;
  }
  return null;
}

export interface PostgresAdapterOptions {
  /** Clock used for UUIDv7 generation. Defaults to the system clock. */
  readonly clock?: Clock;
}

/** Convert a timestamp returned by pg into a core ISO instant. */
function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return isoFromMs(v.getTime());
}

/** Coerce a JSON value returned by pg (already parsed) into the core's
 *  `Readonly<Record<string, JSONValue>>` shape. Pg's jsonb is structurally
 *  `JSONValue` at runtime — this cast only narrows the TS type. */
function toJsonRecord(v: unknown): Readonly<Record<string, JSONValue>> {
  return (v as Readonly<Record<string, JSONValue>>) ?? ({} as Readonly<Record<string, JSONValue>>);
}
function toJsonRecordNullable(v: unknown): Readonly<Record<string, JSONValue>> | null {
  return v === null || v === undefined ? null : (v as Readonly<Record<string, JSONValue>>);
}

/** Map a row returned by pg into a License (converts timestamps). */
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
    is_trial: (r.is_trial as boolean | undefined) ?? false,
    activated_at: toIso(r.activated_at as Date | null),
    expires_at: toIso(r.expires_at as Date | null),
    grace_until: toIso(r.grace_until as Date | null),
    meta: toJsonRecord(r.meta),
    created_at: toIso(r.created_at as Date) as string,
    updated_at: toIso(r.updated_at as Date) as string,
  };
}

function mapScope(r: Record<string, unknown>): LicenseScope {
  return {
    id: r.id as UUIDv7,
    slug: r.slug as string,
    name: r.name as string,
    meta: toJsonRecord(r.meta),
    created_at: toIso(r.created_at as Date) as string,
    updated_at: toIso(r.updated_at as Date) as string,
  };
}

function mapTemplate(r: Record<string, unknown>): LicenseTemplate {
  return {
    id: r.id as UUIDv7,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    parent_id: (r.parent_id as UUIDv7 | null) ?? null,
    name: r.name as string,
    max_usages: r.max_usages as number,
    trial_duration_sec: r.trial_duration_sec as number,
    trial_cooldown_sec: (r.trial_cooldown_sec as number | null) ?? null,
    grace_duration_sec: r.grace_duration_sec as number,
    force_online_after_sec: (r.force_online_after_sec as number | null) ?? null,
    entitlements: toJsonRecord(r.entitlements),
    meta: toJsonRecord(r.meta),
    created_at: toIso(r.created_at as Date) as string,
    updated_at: toIso(r.updated_at as Date) as string,
  };
}

function mapUsage(r: Record<string, unknown>): LicenseUsage {
  return {
    id: r.id as UUIDv7,
    license_id: r.license_id as UUIDv7,
    fingerprint: r.fingerprint as string,
    status: r.status as LicenseUsage['status'],
    registered_at: toIso(r.registered_at as Date) as string,
    revoked_at: toIso(r.revoked_at as Date | null),
    client_meta: toJsonRecord(r.client_meta),
    created_at: toIso(r.created_at as Date) as string,
    updated_at: toIso(r.updated_at as Date) as string,
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
    rotated_at: toIso(r.rotated_at as Date | null),
    not_before: toIso(r.not_before as Date) as string,
    not_after: toIso(r.not_after as Date | null),
    meta: toJsonRecord(r.meta),
    created_at: toIso(r.created_at as Date) as string,
    updated_at: toIso(r.updated_at as Date) as string,
  };
}

function mapTrialIssuance(r: Record<string, unknown>): TrialIssuance {
  return {
    id: r.id as UUIDv7,
    template_id: (r.template_id as UUIDv7 | null) ?? null,
    fingerprint_hash: r.fingerprint_hash as string,
    issued_at: toIso(r.issued_at as Date) as string,
  };
}

function mapAudit(r: Record<string, unknown>): AuditLogEntry {
  return {
    id: r.id as UUIDv7,
    license_id: (r.license_id as UUIDv7 | null) ?? null,
    scope_id: (r.scope_id as UUIDv7 | null) ?? null,
    actor: r.actor as string,
    event: r.event as string,
    prior_state: toJsonRecordNullable(r.prior_state),
    new_state: toJsonRecordNullable(r.new_state),
    occurred_at: toIso(r.occurred_at as Date) as string,
  };
}

export class PostgresStorage implements Storage {
  readonly #q: Queryable;
  readonly #clock: Clock;
  readonly #inTransaction: boolean;

  constructor(pool: Pool, opts?: PostgresAdapterOptions);
  constructor(pool: Pool, opts: PostgresAdapterOptions | undefined, client: PoolClient);
  constructor(pool: Pool, opts: PostgresAdapterOptions = {}, client?: PoolClient) {
    this.#q = client ?? pool;
    this.#clock = opts.clock ?? systemClock;
    this.#inTransaction = client !== undefined;
  }

  // ---------- Licenses ----------

  async createLicense(input: LicenseInput): Promise<License> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO licenses (
           id, scope_id, template_id, licensable_type, licensable_id,
           license_key, status, max_usages, activated_at, expires_at,
           grace_until, meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          id,
          input.scope_id,
          input.template_id,
          input.licensable_type,
          input.licensable_id,
          input.license_key,
          input.status,
          input.max_usages,
          input.activated_at,
          input.expires_at,
          input.grace_until,
          input.meta,
        ],
      );
      return mapLicense(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getLicense(id: UUIDv7): Promise<License | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM licenses WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapLicense(res.rows[0]) : null;
  }

  async getLicenseByKey(licenseKey: string): Promise<License | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM licenses WHERE license_key = $1',
      [licenseKey],
    );
    return res.rows[0] ? mapLicense(res.rows[0]) : null;
  }

  async listLicenses(filter: LicenseFilter, page: PageRequest): Promise<Page<License>> {
    const { where, params } = buildLicenseWhere(filter);
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page, params.length);
    const sql = `
      SELECT * FROM licenses
      WHERE ${where}${cursorClause}
      ORDER BY created_at DESC, id DESC
      ${limitClause}
    `;
    const res = await this.#q.query<Record<string, unknown>>(sql, [...params, ...cursorParams]);
    const rows = res.rows.map(mapLicense);
    return buildPage(rows, limit);
  }

  async findLicensesByLicensable(query: FindByLicensableQuery): Promise<readonly License[]> {
    // Uses the licenses_licensable_type_id_idx introduced in v0002.
    const where: string[] = ['licensable_type = $1', 'licensable_id = $2'];
    const params: unknown[] = [query.type, query.id];
    if (query.scope_id !== undefined) {
      if (query.scope_id === null) {
        where.push('scope_id IS NULL');
      } else {
        params.push(query.scope_id);
        where.push(`scope_id = $${params.length}`);
      }
    }
    const sql = `SELECT * FROM licenses
                 WHERE ${where.join(' AND ')}
                 ORDER BY created_at DESC, id DESC`;
    const res = await this.#q.query<Record<string, unknown>>(sql, params);
    return res.rows.map(mapLicense);
  }

  async updateLicense(id: UUIDv7, patch: LicensePatch): Promise<License> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    if (setSql === null) {
      // Empty patch — just bump updated_at so caller observes no-op semantics
      // consistent with the memory adapter.
      const res = await this.#q.query<Record<string, unknown>>(
        'UPDATE licenses SET updated_at = now() WHERE id = $1 RETURNING *',
        [id],
      );
      if (!res.rows[0]) throw errors.licenseNotFound(id);
      return mapLicense(res.rows[0]);
    }
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `UPDATE licenses SET ${setSql}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      if (!res.rows[0]) throw errors.licenseNotFound(id);
      return mapLicense(res.rows[0]);
    } catch (e) {
      mapPgError(e);
    }
  }

  // ---------- LicenseScopes ----------

  async createScope(input: LicenseScopeInput): Promise<LicenseScope> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO license_scopes (id, slug, name, meta)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, input.slug, input.name, input.meta],
      );
      return mapScope(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getScope(id: UUIDv7): Promise<LicenseScope | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_scopes WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapScope(res.rows[0]) : null;
  }

  async getScopeBySlug(slug: string): Promise<LicenseScope | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_scopes WHERE slug = $1',
      [slug],
    );
    return res.rows[0] ? mapScope(res.rows[0]) : null;
  }

  async listScopes(filter: LicenseScopeFilter, page: PageRequest): Promise<Page<LicenseScope>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.slug !== undefined) {
      params.push(filter.slug);
      where.push(`slug = $${params.length}`);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page, params.length);
    const res = await this.#q.query<Record<string, unknown>>(
      `SELECT * FROM license_scopes
       WHERE ${where.join(' AND ')}${cursorClause}
       ORDER BY created_at DESC, id DESC
       ${limitClause}`,
      [...params, ...cursorParams],
    );
    const rows = res.rows.map(mapScope);
    return buildPage(rows, limit);
  }

  async updateScope(id: UUIDv7, patch: LicenseScopePatch): Promise<LicenseScope> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    try {
      if (setSql === null) {
        const res = await this.#q.query<Record<string, unknown>>(
          'UPDATE license_scopes SET updated_at = now() WHERE id = $1 RETURNING *',
          [id],
        );
        if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
        return mapScope(res.rows[0]);
      }
      const res = await this.#q.query<Record<string, unknown>>(
        `UPDATE license_scopes SET ${setSql}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
      return mapScope(res.rows[0]);
    } catch (e) {
      mapPgError(e);
    }
  }

  // ---------- LicenseTemplates ----------

  async createTemplate(input: LicenseTemplateInput): Promise<LicenseTemplate> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO license_templates (
           id, scope_id, parent_id, name, max_usages, trial_duration_sec,
           trial_cooldown_sec, grace_duration_sec, force_online_after_sec,
           entitlements, meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          input.scope_id,
          input.parent_id,
          input.name,
          input.max_usages,
          input.trial_duration_sec,
          input.trial_cooldown_sec,
          input.grace_duration_sec,
          input.force_online_after_sec,
          input.entitlements,
          input.meta,
        ],
      );
      return mapTemplate(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getTemplate(id: UUIDv7): Promise<LicenseTemplate | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_templates WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapTemplate(res.rows[0]) : null;
  }

  async listTemplates(
    filter: LicenseTemplateFilter,
    page: PageRequest,
  ): Promise<Page<LicenseTemplate>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.scope_id !== undefined) {
      params.push(filter.scope_id);
      // scope_id IS NULL / IS NOT NULL + filter value.
      if (filter.scope_id === null) where.push('scope_id IS NULL');
      else where.push(`scope_id = $${params.length}`);
    }
    if (filter.name !== undefined) {
      params.push(filter.name);
      where.push(`name = $${params.length}`);
    }
    if (filter.parent_id !== undefined) {
      if (filter.parent_id === null) {
        where.push('parent_id IS NULL');
      } else {
        params.push(filter.parent_id);
        where.push(`parent_id = $${params.length}`);
      }
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page, params.length);
    const res = await this.#q.query<Record<string, unknown>>(
      `SELECT * FROM license_templates
       WHERE ${where.join(' AND ')}${cursorClause}
       ORDER BY created_at DESC, id DESC
       ${limitClause}`,
      [...params, ...cursorParams],
    );
    const rows = res.rows.map(mapTemplate);
    return buildPage(rows, limit);
  }

  async updateTemplate(id: UUIDv7, patch: LicenseTemplatePatch): Promise<LicenseTemplate> {
    try {
      // Cycle detection: if parent_id is being set to a non-null value,
      // walk forward from the new parent and bail if we would revisit `id`.
      if (patch.parent_id !== undefined && patch.parent_id !== null) {
        const cycle = await walkPgParentChain(this.#q, patch.parent_id, id);
        if (cycle !== null) {
          throw errors.templateCycle(id, cycle);
        }
      }
      const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
      if (setSql === null) {
        const res = await this.#q.query<Record<string, unknown>>(
          'UPDATE license_templates SET updated_at = now() WHERE id = $1 RETURNING *',
          [id],
        );
        if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
        return mapTemplate(res.rows[0]);
      }
      const res = await this.#q.query<Record<string, unknown>>(
        `UPDATE license_templates SET ${setSql}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
      return mapTemplate(res.rows[0]);
    } catch (e) {
      mapPgError(e);
    }
  }

  // ---------- LicenseUsages ----------

  async createUsage(input: LicenseUsageInput): Promise<LicenseUsage> {
    const id = newUuidV7(this.#clock);
    // Seat check: take a row lock on the parent license so concurrent
    // registrations serialize. The caller is responsible for doing this
    // inside a `withTransaction`; without one, FOR UPDATE is still valid but
    // the lock is released at statement end, which is fine for the "ensure
    // license exists" read here. Real seat enforcement (counting active
    // usages vs max_usages) belongs to the issuer in Phase 5; the unique
    // partial index below protects against duplicate-active-fingerprint
    // races regardless.
    if (this.#inTransaction) {
      await this.#q.query('SELECT id FROM licenses WHERE id = $1 FOR UPDATE', [input.license_id]);
    }
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO license_usages (
           id, license_id, fingerprint, status, registered_at, revoked_at, client_meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          id,
          input.license_id,
          input.fingerprint,
          input.status,
          input.registered_at,
          input.revoked_at,
          input.client_meta,
        ],
      );
      return mapUsage(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getUsage(id: UUIDv7): Promise<LicenseUsage | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_usages WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapUsage(res.rows[0]) : null;
  }

  async listUsages(filter: LicenseUsageFilter, page: PageRequest): Promise<Page<LicenseUsage>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.license_id !== undefined) {
      params.push(filter.license_id);
      where.push(`license_id = $${params.length}`);
    }
    if (filter.fingerprint !== undefined) {
      params.push(filter.fingerprint);
      where.push(`fingerprint = $${params.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      params.push(filter.status);
      where.push(`status = ANY($${params.length})`);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page, params.length);
    const res = await this.#q.query<Record<string, unknown>>(
      `SELECT * FROM license_usages
       WHERE ${where.join(' AND ')}${cursorClause}
       ORDER BY created_at DESC, id DESC
       ${limitClause}`,
      [...params, ...cursorParams],
    );
    const rows = res.rows.map(mapUsage);
    return buildPage(rows, limit);
  }

  async updateUsage(id: UUIDv7, patch: LicenseUsagePatch): Promise<LicenseUsage> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    try {
      if (setSql === null) {
        const res = await this.#q.query<Record<string, unknown>>(
          'UPDATE license_usages SET updated_at = now() WHERE id = $1 RETURNING *',
          [id],
        );
        if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
        return mapUsage(res.rows[0]);
      }
      const res = await this.#q.query<Record<string, unknown>>(
        `UPDATE license_usages SET ${setSql}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
      return mapUsage(res.rows[0]);
    } catch (e) {
      mapPgError(e);
    }
  }

  // ---------- LicenseKeys ----------

  async createKey(input: LicenseKeyInput): Promise<LicenseKey> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO license_keys (
           id, scope_id, kid, alg, role, state, public_pem, private_pem_enc,
           rotated_from, rotated_at, not_before, not_after, meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          id,
          input.scope_id,
          input.kid,
          input.alg,
          input.role,
          input.state,
          input.public_pem,
          input.private_pem_enc,
          input.rotated_from,
          input.rotated_at,
          input.not_before,
          input.not_after,
          input.meta,
        ],
      );
      return mapKey(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getKey(id: UUIDv7): Promise<LicenseKey | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_keys WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapKey(res.rows[0]) : null;
  }

  async getKeyByKid(kid: string): Promise<LicenseKey | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM license_keys WHERE kid = $1',
      [kid],
    );
    return res.rows[0] ? mapKey(res.rows[0]) : null;
  }

  async listKeys(filter: LicenseKeyFilter, page: PageRequest): Promise<Page<LicenseKey>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.scope_id !== undefined) {
      if (filter.scope_id === null) where.push('scope_id IS NULL');
      else {
        params.push(filter.scope_id);
        where.push(`scope_id = $${params.length}`);
      }
    }
    if (filter.kid !== undefined) {
      params.push(filter.kid);
      where.push(`kid = $${params.length}`);
    }
    if (filter.alg !== undefined) {
      params.push(filter.alg);
      where.push(`alg = $${params.length}`);
    }
    if (filter.role !== undefined) {
      params.push(filter.role);
      where.push(`role = $${params.length}`);
    }
    if (filter.state !== undefined) {
      params.push(filter.state);
      where.push(`state = $${params.length}`);
    }
    const { limitClause, cursorClause, cursorParams, limit } = buildPagination(page, params.length);
    const res = await this.#q.query<Record<string, unknown>>(
      `SELECT * FROM license_keys
       WHERE ${where.join(' AND ')}${cursorClause}
       ORDER BY created_at DESC, id DESC
       ${limitClause}`,
      [...params, ...cursorParams],
    );
    const rows = res.rows.map(mapKey);
    return buildPage(rows, limit);
  }

  async updateKey(id: UUIDv7, patch: LicenseKeyPatch): Promise<LicenseKey> {
    const { setSql, values } = buildUpdateSet(patch as unknown as Record<string, unknown>);
    try {
      if (setSql === null) {
        const res = await this.#q.query<Record<string, unknown>>(
          'UPDATE license_keys SET updated_at = now() WHERE id = $1 RETURNING *',
          [id],
        );
        if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
        return mapKey(res.rows[0]);
      }
      const res = await this.#q.query<Record<string, unknown>>(
        `UPDATE license_keys SET ${setSql}, updated_at = now() WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      if (!res.rows[0]) throw errors.uniqueConstraintViolation('pk', id);
      return mapKey(res.rows[0]);
    } catch (e) {
      mapPgError(e);
    }
  }

  // ---------- AuditLog ----------

  async appendAudit(input: AuditLogInput): Promise<AuditLogEntry> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO audit_logs (
           id, license_id, scope_id, actor, event, prior_state, new_state, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id,
          input.license_id,
          input.scope_id,
          input.actor,
          input.event,
          input.prior_state,
          input.new_state,
          input.occurred_at,
        ],
      );
      return mapAudit(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async getAudit(id: UUIDv7): Promise<AuditLogEntry | null> {
    const res = await this.#q.query<Record<string, unknown>>(
      'SELECT * FROM audit_logs WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapAudit(res.rows[0]) : null;
  }

  async listAudit(filter: AuditLogFilter, page: PageRequest): Promise<Page<AuditLogEntry>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    let fromClause = 'audit_logs a';
    if (filter.license_id !== undefined) {
      if (filter.license_id === null) where.push('a.license_id IS NULL');
      else {
        params.push(filter.license_id);
        where.push(`a.license_id = $${params.length}`);
      }
    }
    if (filter.scope_id !== undefined) {
      if (filter.scope_id === null) where.push('a.scope_id IS NULL');
      else {
        params.push(filter.scope_id);
        where.push(`a.scope_id = $${params.length}`);
      }
    }
    if (filter.event !== undefined) {
      const events = Array.isArray(filter.event) ? filter.event : [filter.event];
      if (events.length === 0) return { items: [], cursor: null };
      const placeholders = events.map((_, i) => `$${params.length + i + 1}`).join(',');
      where.push(`a.event IN (${placeholders})`);
      for (const e of events) params.push(e);
    }
    if (filter.actor !== undefined) {
      params.push(filter.actor);
      where.push(`a.actor = $${params.length}`);
    }
    if (filter.since !== undefined) {
      params.push(filter.since);
      where.push(`a.occurred_at >= $${params.length}`);
    }
    if (filter.until !== undefined) {
      params.push(filter.until);
      where.push(`a.occurred_at < $${params.length}`);
    }
    if (filter.licensable_type !== undefined || filter.licensable_id !== undefined) {
      fromClause = 'audit_logs a INNER JOIN licenses l ON l.id = a.license_id';
      if (filter.licensable_type !== undefined) {
        params.push(filter.licensable_type);
        where.push(`l.licensable_type = $${params.length}`);
      }
      if (filter.licensable_id !== undefined) {
        params.push(filter.licensable_id);
        where.push(`l.licensable_id = $${params.length}`);
      }
    }
    const limit = Math.max(1, Math.min(page.limit, 500));
    const cursor = decodeCursor(page.cursor);
    let cursorClause = '';
    const cursorParams: unknown[] = [];
    if (cursor) {
      cursorParams.push(cursor.createdAt, cursor.id);
      cursorClause = ` AND (a.occurred_at, a.id) < ($${params.length + 1}, $${params.length + 2})`;
    }
    const res = await this.#q.query<Record<string, unknown>>(
      `SELECT a.* FROM ${fromClause}
       WHERE ${where.join(' AND ')}${cursorClause}
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ${limit + 1}`,
      [...params, ...cursorParams],
    );
    const rows = res.rows.map(mapAudit);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      cursor: hasMore && last ? encodeCursor({ createdAt: last.occurred_at, id: last.id }) : null,
    };
  }

  // ---------- TrialIssuances (added in v0002) ----------

  async recordTrialIssuance(input: TrialIssuanceInput): Promise<TrialIssuance> {
    const id = newUuidV7(this.#clock);
    try {
      const res = await this.#q.query<Record<string, unknown>>(
        `INSERT INTO trial_issuances (id, template_id, fingerprint_hash)
         VALUES ($1,$2,$3) RETURNING *`,
        [id, input.template_id, input.fingerprint_hash],
      );
      return mapTrialIssuance(res.rows[0] as Record<string, unknown>);
    } catch (e) {
      mapPgError(e);
    }
  }

  async findTrialIssuance(query: TrialIssuanceLookup): Promise<TrialIssuance | null> {
    const sql =
      query.template_id === null
        ? 'SELECT * FROM trial_issuances WHERE template_id IS NULL AND fingerprint_hash = $1 ORDER BY issued_at DESC LIMIT 1'
        : 'SELECT * FROM trial_issuances WHERE template_id = $1 AND fingerprint_hash = $2 ORDER BY issued_at DESC LIMIT 1';
    const params: unknown[] =
      query.template_id === null
        ? [query.fingerprint_hash]
        : [query.template_id, query.fingerprint_hash];
    const res = await this.#q.query<Record<string, unknown>>(sql, params);
    return res.rows[0] ? mapTrialIssuance(res.rows[0]) : null;
  }

  async deleteTrialIssuance(id: UUIDv7): Promise<void> {
    await this.#q.query('DELETE FROM trial_issuances WHERE id = $1', [id]);
  }

  // ---------- Transactions & schema ----------

  async withTransaction<T>(fn: (tx: StorageTx) => Promise<T>): Promise<T> {
    if (this.#inTransaction) {
      throw new Error(
        'nested transactions are not supported by @anorebel/licensing/storage/postgres',
      );
    }
    if (!('connect' in this.#q)) {
      // Should be impossible given the type guards, but be explicit.
      throw new Error('withTransaction requires a pool-bound adapter');
    }
    const pool = this.#q as Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresStorage(pool, { clock: this.#clock }, client);
      try {
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      client.release();
    }
  }

  describeSchema(): SchemaDescription {
    return POSTGRES_SCHEMA;
  }

  async close(): Promise<void> {
    // Owned by the caller. We do NOT end the pool here — a consumer may be
    // using the same pool for other work.
  }
}

// ---------- SQL helpers ----------

/** Build the `WHERE` fragment for a LicenseFilter. */
function buildLicenseWhere(filter: LicenseFilter): { where: string; params: unknown[] } {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (filter.scope_id !== undefined) {
    if (filter.scope_id === null) where.push('scope_id IS NULL');
    else {
      params.push(filter.scope_id);
      where.push(`scope_id = $${params.length}`);
    }
  }
  if (filter.status && filter.status.length > 0) {
    params.push(filter.status);
    where.push(`status = ANY($${params.length})`);
  }
  if (filter.licensable_type !== undefined) {
    params.push(filter.licensable_type);
    where.push(`licensable_type = $${params.length}`);
  }
  if (filter.licensable_id !== undefined) {
    params.push(filter.licensable_id);
    where.push(`licensable_id = $${params.length}`);
  }
  if (filter.template_id !== undefined) {
    if (filter.template_id === null) where.push('template_id IS NULL');
    else {
      params.push(filter.template_id);
      where.push(`template_id = $${params.length}`);
    }
  }
  return { where: where.join(' AND '), params };
}

/** Build the `SET` fragment for an update. Returns null if the patch has no
 *  keys (caller handles the no-op case). */
function buildUpdateSet(patch: Record<string, unknown>): {
  setSql: string | null;
  values: unknown[];
} {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  if (sets.length === 0) return { setSql: null, values: [] };
  return { setSql: sets.join(', '), values };
}

/** Build the cursor + LIMIT clauses for a list query. Returns placeholders
 *  relative to the *next* available $N after the filter params. */
function buildPagination(
  page: PageRequest,
  paramsUsed: number,
): {
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
    cursorClause: ` AND (created_at, id) < ($${paramsUsed + 1}, $${paramsUsed + 2})`,
    cursorParams: [cursor.createdAt, cursor.id],
    limit,
  };
}

/** Slice the `limit + 1` rows into a page with cursor. */
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
