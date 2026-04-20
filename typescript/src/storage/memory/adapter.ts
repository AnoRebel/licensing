/**
 * In-memory storage adapter.
 *
 * State is held in six JavaScript `Map<id, row>` tables, one per entity.
 * This keeps lookups O(1) by primary key, and O(n) for the handful of
 * natural-key / filter scans — acceptable for a test/dev adapter.
 *
 * Transactional model:
 *   - `withTransaction(fn)` clones every table up front (shallow — the rows
 *     themselves are readonly so sharing references is safe).
 *   - `fn` receives a `StorageTx` that writes to the cloned tables only.
 *   - On successful return, the cloned tables replace the live ones atomically
 *     via a single assignment. A commit can never observe a half-applied
 *     state because nothing outside the adapter holds a reference to the old
 *     table Maps after the assignment.
 *   - On thrown error, the cloned tables are dropped. Live tables are
 *     unchanged.
 *
 * Nested transactions are not supported — supporting savepoints in the
 * memory adapter would drift from how Postgres/SQLite adapters behave
 * (they'll throw on nested BEGIN too).
 * Calling `withTransaction` from inside a running transaction's `fn` throws.
 *
 * Uniqueness:
 *   Every `create*` method scans for conflicts BEFORE inserting. Conflicts
 *   throw the canonical error (LicenseKeyConflict / UniqueConstraintViolation).
 *   This is checked inside the transaction snapshot, so concurrent txs that
 *   would both win the uniqueness race cannot both commit: the second commit's
 *   pre-check sees the first tx's inserted row.
 *
 * AuditLog immutability:
 *   The adapter exposes `appendAudit`, `getAudit`, `listAudit` only. There's
 *   no path to mutate an audit row — append-only by construction. (Spec asks
 *   for explicit rejection; if a future refactor ever adds `updateAudit`, it
 *   must call `errors.immutableAuditLog()` first.)
 */

import {
  type AuditLogEntry,
  type AuditLogFilter,
  type AuditLogInput,
  type Clock,
  errors,
  isoFromMs,
  type License,
  type LicenseFilter,
  type LicenseInput,
  type LicenseKey,
  type LicenseKeyFilter,
  type LicenseKeyInput,
  type LicenseKeyPatch,
  type LicensePatch,
  type LicenseScope,
  type LicenseScopeFilter,
  type LicenseScopeInput,
  type LicenseScopePatch,
  type LicenseTemplate,
  type LicenseTemplateFilter,
  type LicenseTemplateInput,
  type LicenseTemplatePatch,
  type LicenseUsage,
  type LicenseUsageFilter,
  type LicenseUsageInput,
  type LicenseUsagePatch,
  newUuidV7,
  type Page,
  type PageRequest,
  type SchemaDescription,
  type Storage,
  type StorageTx,
  systemClock,
  type UUIDv7,
} from '../../index.ts';

import { compareDesc, decodeCursor, encodeCursor, isAfter } from './cursor.ts';
import { MEMORY_SCHEMA } from './schema.ts';

/** Shape of the adapter's internal state. Every field is a `Map<id, row>` —
 *  swapping them wholesale is how commit/rollback is implemented. */
interface State {
  licenses: Map<UUIDv7, License>;
  scopes: Map<UUIDv7, LicenseScope>;
  templates: Map<UUIDv7, LicenseTemplate>;
  usages: Map<UUIDv7, LicenseUsage>;
  keys: Map<UUIDv7, LicenseKey>;
  audit: Map<UUIDv7, AuditLogEntry>;
}

function emptyState(): State {
  return {
    licenses: new Map(),
    scopes: new Map(),
    templates: new Map(),
    usages: new Map(),
    keys: new Map(),
    audit: new Map(),
  };
}

function cloneState(s: State): State {
  return {
    licenses: new Map(s.licenses),
    scopes: new Map(s.scopes),
    templates: new Map(s.templates),
    usages: new Map(s.usages),
    keys: new Map(s.keys),
    audit: new Map(s.audit),
  };
}

export interface MemoryAdapterOptions {
  /** Clock used for `created_at` / `updated_at`. Defaults to the system clock. */
  readonly clock?: Clock;
}

export class MemoryStorage implements Storage {
  private state: State;
  private readonly clock: Clock;
  /** Non-null while a transaction is mid-flight on this instance. Used to
   *  reject nested `withTransaction` calls. */
  private txDepth = 0;

  constructor(opts: MemoryAdapterOptions = {}) {
    this.state = emptyState();
    this.clock = opts.clock ?? systemClock;
  }

  // ---------- Licenses ----------

  async createLicense(input: LicenseInput): Promise<License> {
    return this.writeOp((s) => {
      // Unique: license_key (global), (licensable_type, licensable_id, scope_id).
      for (const row of s.licenses.values()) {
        if (row.license_key === input.license_key) {
          throw errors.licenseKeyConflict(input.license_key);
        }
        if (
          row.licensable_type === input.licensable_type &&
          row.licensable_id === input.licensable_id &&
          row.scope_id === input.scope_id
        ) {
          throw errors.uniqueConstraintViolation(
            'licensable_scope',
            `${input.licensable_type}:${input.licensable_id}:${input.scope_id ?? 'null'}`,
          );
        }
      }
      const now = this.nowIso();
      const row: License = {
        id: newUuidV7(this.clock),
        scope_id: input.scope_id,
        template_id: input.template_id,
        licensable_type: input.licensable_type,
        licensable_id: input.licensable_id,
        license_key: input.license_key,
        status: input.status,
        max_usages: input.max_usages,
        activated_at: input.activated_at,
        expires_at: input.expires_at,
        grace_until: input.grace_until,
        meta: input.meta,
        created_at: now,
        updated_at: now,
      };
      s.licenses.set(row.id, row);
      return row;
    });
  }

  async getLicense(id: UUIDv7): Promise<License | null> {
    return this.state.licenses.get(id) ?? null;
  }

  async getLicenseByKey(licenseKey: string): Promise<License | null> {
    for (const row of this.state.licenses.values()) {
      if (row.license_key === licenseKey) return row;
    }
    return null;
  }

  async listLicenses(filter: LicenseFilter, page: PageRequest): Promise<Page<License>> {
    const filtered = [...this.state.licenses.values()].filter((r) => {
      if (filter.scope_id !== undefined && r.scope_id !== filter.scope_id) return false;
      if (filter.status && !filter.status.includes(r.status)) return false;
      if (filter.licensable_type !== undefined && r.licensable_type !== filter.licensable_type)
        return false;
      if (filter.licensable_id !== undefined && r.licensable_id !== filter.licensable_id)
        return false;
      if (filter.template_id !== undefined && r.template_id !== filter.template_id) return false;
      return true;
    });
    return paginate(filtered, page);
  }

  async updateLicense(id: UUIDv7, patch: LicensePatch): Promise<License> {
    return this.writeOp((s) => {
      const cur = s.licenses.get(id);
      if (!cur) throw errors.licenseNotFound(id);
      const next: License = {
        ...cur,
        ...patch,
        updated_at: this.nowIso(),
      };
      s.licenses.set(id, next);
      return next;
    });
  }

  // ---------- LicenseScopes ----------

  async createScope(input: LicenseScopeInput): Promise<LicenseScope> {
    return this.writeOp((s) => {
      for (const row of s.scopes.values()) {
        if (row.slug === input.slug) {
          throw errors.uniqueConstraintViolation('slug', input.slug);
        }
      }
      const now = this.nowIso();
      const row: LicenseScope = {
        id: newUuidV7(this.clock),
        slug: input.slug,
        name: input.name,
        meta: input.meta,
        created_at: now,
        updated_at: now,
      };
      s.scopes.set(row.id, row);
      return row;
    });
  }

  async getScope(id: UUIDv7): Promise<LicenseScope | null> {
    return this.state.scopes.get(id) ?? null;
  }

  async getScopeBySlug(slug: string): Promise<LicenseScope | null> {
    for (const row of this.state.scopes.values()) {
      if (row.slug === slug) return row;
    }
    return null;
  }

  async listScopes(filter: LicenseScopeFilter, page: PageRequest): Promise<Page<LicenseScope>> {
    const filtered = [...this.state.scopes.values()].filter((r) => {
      if (filter.slug !== undefined && r.slug !== filter.slug) return false;
      return true;
    });
    return paginate(filtered, page);
  }

  async updateScope(id: UUIDv7, patch: LicenseScopePatch): Promise<LicenseScope> {
    return this.writeOp((s) => {
      const cur = s.scopes.get(id);
      if (!cur) throw errors.uniqueConstraintViolation('pk', id);
      const next: LicenseScope = {
        ...cur,
        ...patch,
        updated_at: this.nowIso(),
      };
      s.scopes.set(id, next);
      return next;
    });
  }

  // ---------- LicenseTemplates ----------

  async createTemplate(input: LicenseTemplateInput): Promise<LicenseTemplate> {
    return this.writeOp((s) => {
      // Unique: (scope_id, name) — NULL scope_id is treated as its own group.
      for (const row of s.templates.values()) {
        if (row.scope_id === input.scope_id && row.name === input.name) {
          throw errors.uniqueConstraintViolation(
            'scope_name',
            `${input.scope_id ?? 'null'}:${input.name}`,
          );
        }
      }
      const now = this.nowIso();
      const row: LicenseTemplate = {
        id: newUuidV7(this.clock),
        scope_id: input.scope_id,
        name: input.name,
        max_usages: input.max_usages,
        trial_duration_sec: input.trial_duration_sec,
        grace_duration_sec: input.grace_duration_sec,
        force_online_after_sec: input.force_online_after_sec,
        entitlements: input.entitlements,
        meta: input.meta,
        created_at: now,
        updated_at: now,
      };
      s.templates.set(row.id, row);
      return row;
    });
  }

  async getTemplate(id: UUIDv7): Promise<LicenseTemplate | null> {
    return this.state.templates.get(id) ?? null;
  }

  async listTemplates(
    filter: LicenseTemplateFilter,
    page: PageRequest,
  ): Promise<Page<LicenseTemplate>> {
    const filtered = [...this.state.templates.values()].filter((r) => {
      if (filter.scope_id !== undefined && r.scope_id !== filter.scope_id) return false;
      if (filter.name !== undefined && r.name !== filter.name) return false;
      return true;
    });
    return paginate(filtered, page);
  }

  async updateTemplate(id: UUIDv7, patch: LicenseTemplatePatch): Promise<LicenseTemplate> {
    return this.writeOp((s) => {
      const cur = s.templates.get(id);
      if (!cur) throw errors.uniqueConstraintViolation('pk', id);
      const next: LicenseTemplate = {
        ...cur,
        ...patch,
        updated_at: this.nowIso(),
      };
      s.templates.set(id, next);
      return next;
    });
  }

  // ---------- LicenseUsages ----------

  async createUsage(input: LicenseUsageInput): Promise<LicenseUsage> {
    return this.writeOp((s) => {
      // Partial unique: (license_id, fingerprint) WHERE status = 'active'.
      // A fingerprint may re-register after revocation; it cannot be active
      // twice simultaneously.
      if (input.status === 'active') {
        for (const row of s.usages.values()) {
          if (
            row.license_id === input.license_id &&
            row.fingerprint === input.fingerprint &&
            row.status === 'active'
          ) {
            throw errors.uniqueConstraintViolation(
              'license_fingerprint_active',
              `${input.license_id}:${input.fingerprint}`,
            );
          }
        }
      }
      const now = this.nowIso();
      const row: LicenseUsage = {
        id: newUuidV7(this.clock),
        license_id: input.license_id,
        fingerprint: input.fingerprint,
        status: input.status,
        registered_at: input.registered_at,
        revoked_at: input.revoked_at,
        client_meta: input.client_meta,
        created_at: now,
        updated_at: now,
      };
      s.usages.set(row.id, row);
      return row;
    });
  }

  async getUsage(id: UUIDv7): Promise<LicenseUsage | null> {
    return this.state.usages.get(id) ?? null;
  }

  async listUsages(filter: LicenseUsageFilter, page: PageRequest): Promise<Page<LicenseUsage>> {
    const filtered = [...this.state.usages.values()].filter((r) => {
      if (filter.license_id !== undefined && r.license_id !== filter.license_id) return false;
      if (filter.fingerprint !== undefined && r.fingerprint !== filter.fingerprint) return false;
      if (filter.status && !filter.status.includes(r.status)) return false;
      return true;
    });
    return paginate(filtered, page);
  }

  async updateUsage(id: UUIDv7, patch: LicenseUsagePatch): Promise<LicenseUsage> {
    return this.writeOp((s) => {
      const cur = s.usages.get(id);
      if (!cur) throw errors.uniqueConstraintViolation('pk', id);
      // Re-enforce partial-unique if transitioning TO active.
      if (patch.status === 'active' && cur.status !== 'active') {
        for (const row of s.usages.values()) {
          if (
            row.id !== id &&
            row.license_id === cur.license_id &&
            row.fingerprint === cur.fingerprint &&
            row.status === 'active'
          ) {
            throw errors.uniqueConstraintViolation(
              'license_fingerprint_active',
              `${cur.license_id}:${cur.fingerprint}`,
            );
          }
        }
      }
      const next: LicenseUsage = {
        ...cur,
        ...patch,
        updated_at: this.nowIso(),
      };
      s.usages.set(id, next);
      return next;
    });
  }

  // ---------- LicenseKeys ----------

  async createKey(input: LicenseKeyInput): Promise<LicenseKey> {
    return this.writeOp((s) => {
      // Unique: kid (global).
      for (const row of s.keys.values()) {
        if (row.kid === input.kid) throw errors.uniqueConstraintViolation('kid', input.kid);
      }
      // Partial unique: (scope_id, role) WHERE state='active' AND role='signing'.
      if (input.role === 'signing' && input.state === 'active') {
        for (const row of s.keys.values()) {
          if (row.role === 'signing' && row.state === 'active' && row.scope_id === input.scope_id) {
            throw errors.uniqueConstraintViolation(
              'scope_active_signing',
              `${input.scope_id ?? 'null'}`,
            );
          }
        }
      }
      const now = this.nowIso();
      const row: LicenseKey = {
        id: newUuidV7(this.clock),
        scope_id: input.scope_id,
        kid: input.kid,
        alg: input.alg,
        role: input.role,
        state: input.state,
        public_pem: input.public_pem,
        private_pem_enc: input.private_pem_enc,
        rotated_from: input.rotated_from,
        rotated_at: input.rotated_at,
        not_before: input.not_before,
        not_after: input.not_after,
        meta: input.meta,
        created_at: now,
        updated_at: now,
      };
      s.keys.set(row.id, row);
      return row;
    });
  }

  async getKey(id: UUIDv7): Promise<LicenseKey | null> {
    return this.state.keys.get(id) ?? null;
  }

  async getKeyByKid(kid: string): Promise<LicenseKey | null> {
    for (const row of this.state.keys.values()) {
      if (row.kid === kid) return row;
    }
    return null;
  }

  async listKeys(filter: LicenseKeyFilter, page: PageRequest): Promise<Page<LicenseKey>> {
    const filtered = [...this.state.keys.values()].filter((r) => {
      if (filter.scope_id !== undefined && r.scope_id !== filter.scope_id) return false;
      if (filter.kid !== undefined && r.kid !== filter.kid) return false;
      if (filter.alg !== undefined && r.alg !== filter.alg) return false;
      if (filter.role !== undefined && r.role !== filter.role) return false;
      if (filter.state !== undefined && r.state !== filter.state) return false;
      return true;
    });
    return paginate(filtered, page);
  }

  async updateKey(id: UUIDv7, patch: LicenseKeyPatch): Promise<LicenseKey> {
    return this.writeOp((s) => {
      const cur = s.keys.get(id);
      if (!cur) throw errors.uniqueConstraintViolation('pk', id);
      // Re-enforce partial-unique when activating a signing key.
      if (
        patch.state === 'active' &&
        cur.state !== 'active' &&
        cur.role === 'signing' &&
        (patch.state as string) === 'active'
      ) {
        for (const row of s.keys.values()) {
          if (
            row.id !== id &&
            row.role === 'signing' &&
            row.state === 'active' &&
            row.scope_id === cur.scope_id
          ) {
            throw errors.uniqueConstraintViolation(
              'scope_active_signing',
              `${cur.scope_id ?? 'null'}`,
            );
          }
        }
      }
      const next: LicenseKey = {
        ...cur,
        ...patch,
        updated_at: this.nowIso(),
      };
      s.keys.set(id, next);
      return next;
    });
  }

  // ---------- AuditLog ----------

  async appendAudit(input: AuditLogInput): Promise<AuditLogEntry> {
    return this.writeOp((s) => {
      const row: AuditLogEntry = {
        id: newUuidV7(this.clock),
        license_id: input.license_id,
        scope_id: input.scope_id,
        actor: input.actor,
        event: input.event,
        prior_state: input.prior_state,
        new_state: input.new_state,
        occurred_at: input.occurred_at,
      };
      s.audit.set(row.id, row);
      return row;
    });
  }

  async getAudit(id: UUIDv7): Promise<AuditLogEntry | null> {
    return this.state.audit.get(id) ?? null;
  }

  async listAudit(filter: AuditLogFilter, page: PageRequest): Promise<Page<AuditLogEntry>> {
    const filtered = [...this.state.audit.values()].filter((r) => {
      if (filter.license_id !== undefined && r.license_id !== filter.license_id) return false;
      if (filter.scope_id !== undefined && r.scope_id !== filter.scope_id) return false;
      if (filter.event !== undefined && r.event !== filter.event) return false;
      return true;
    });
    // AuditLog orders by `occurred_at DESC, id DESC` — shimmed into the
    // generic paginator by aliasing `occurred_at` onto `created_at` for the
    // comparator. The entity has no `created_at`; `occurred_at` plays the
    // same role here.
    const shimmed = filtered.map((r) => ({ ...r, created_at: r.occurred_at }));
    const paged = paginate(shimmed, page);
    return {
      // Strip the shim back out before returning to the caller.
      items: paged.items.map(({ created_at: _unused, ...rest }) => rest as AuditLogEntry),
      cursor: paged.cursor,
    };
  }

  // ---------- Transactions & schema ----------

  async withTransaction<T>(fn: (tx: StorageTx) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      throw new Error('nested transactions are not supported by @licensing/sdk/storage/memory');
    }
    this.txDepth++;
    const snapshot = cloneState(this.state);
    // The tx sees a cloned state. The outer `this.state` is restored on
    // failure by doing nothing (we never wrote to it); on success we swap
    // the clone in wholesale.
    const live = this.state;
    this.state = snapshot;
    try {
      // `fn` gets `this` as the tx — same instance, same methods. The
      // tx-vs-non-tx distinction is purely in whether we're already inside
      // a withTransaction frame.
      const result = await fn(this);
      // Commit: the modified snapshot IS `this.state`, so we're already
      // there. Just null out the rollback pointer.
      void live;
      return result;
    } catch (err) {
      // Rollback: restore the live table references.
      this.state = live;
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  describeSchema(): SchemaDescription {
    return MEMORY_SCHEMA;
  }

  async close(): Promise<void> {
    // No resources held.
  }

  // ---------- internals ----------

  private nowIso(): string {
    return isoFromMs(this.clock.nowMs());
  }

  /** Helper: execute a write against `this.state`. Callers that mutate via
   *  the returned `s` reference are implicitly writing to whichever state
   *  the current tx frame owns (the cloned snapshot, or the live state if
   *  not inside `withTransaction`). */
  private writeOp<T>(op: (s: State) => T): Promise<T> {
    return Promise.resolve(op(this.state));
  }
}

// ---------- pagination helper ----------

/** Sort + slice a row set under the canonical DESC order. Works for any row
 *  that carries `{ created_at, id }`. */
function paginate<T extends { readonly created_at: string; readonly id: string }>(
  rows: readonly T[],
  page: PageRequest,
): Page<T> {
  const limit = Math.max(1, Math.min(page.limit, 500));
  const sorted = [...rows].sort(compareDesc);
  const cursor = decodeCursor(page.cursor);
  const start = cursor === null ? 0 : sorted.findIndex((r) => isAfter(r, cursor));
  if (cursor !== null && start === -1) {
    return { items: [], cursor: null };
  }
  const slice = sorted.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + limit);
  const hasMore = (start === -1 ? 0 : start) + slice.length < sorted.length;
  const last = slice.at(-1);
  return {
    items: slice,
    cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
