/**
 * Shared storage contract. Every adapter (`@anorebel/licensing/storage/memory`,
 * `@anorebel/licensing/storage/postgres`, `@anorebel/licensing/storage/sqlite`) implements
 * {@link Storage}. The core lifecycle/state-machine code depends only on
 * this interface, never on a specific adapter.
 *
 * Contract anchors:
 *   - Spec: `openspec/changes/port-laravel-licensing-to-ts-and-go/specs/licensing-storage/spec.md`
 *   - Canonical field layout: `fixtures/schema/entities.md`
 *
 * Design notes:
 *   1. Inputs are `*Input` shapes — they omit storage-managed fields (`id`,
 *      `created_at`, `updated_at`). The adapter populates them. Supplying
 *      them in input is tolerated but MUST be ignored per entities.md §7.
 *   2. Updates use a `Partial<…Patch>` shape keyed by `id`. Only mutable
 *      fields are in the patch; unique natural keys (`license_key`, `slug`,
 *      `kid`, `fingerprint`) are never updatable.
 *   3. Lists always return a page + opaque `cursor`. A null cursor means the
 *      caller has reached the end. The cursor is adapter-specific but the
 *      opacity contract is universal: callers pass it back verbatim.
 *   4. `withTransaction(fn)` is the sole primitive that crosses rows within
 *      an atomic unit. The memory adapter implements it via snapshot +
 *      commit-on-success; Postgres/SQLite use native BEGIN/COMMIT. Errors
 *      thrown inside `fn` MUST roll the snapshot back.
 *   5. AuditLog is write-once. Adapters MUST reject UPDATE/DELETE with
 *      `ImmutableAuditLog` (enforced adapter-side, not just in a wrapper).
 */

import type {
  AuditLogEntry,
  JSONValue,
  KeyAlg,
  KeyRole,
  KeyState,
  License,
  LicenseKey,
  LicenseScope,
  LicenseStatus,
  LicenseTemplate,
  LicenseUsage,
  UsageStatus,
  UUIDv7,
} from '../types.ts';

// ---------- Input shapes (caller-supplied; storage-managed fields omitted) ----------

export interface LicenseInput {
  readonly scope_id: UUIDv7 | null;
  readonly template_id: UUIDv7 | null;
  readonly licensable_type: string;
  readonly licensable_id: string;
  readonly license_key: string;
  readonly status: LicenseStatus;
  readonly max_usages: number;
  readonly activated_at: string | null;
  readonly expires_at: string | null;
  readonly grace_until: string | null;
  readonly meta: Readonly<Record<string, JSONValue>>;
}

export interface LicenseScopeInput {
  readonly slug: string;
  readonly name: string;
  readonly meta: Readonly<Record<string, JSONValue>>;
}

export interface LicenseTemplateInput {
  readonly scope_id: UUIDv7 | null;
  /** Self-FK enabling template inheritance. Null means "no parent". Added in v0002. */
  readonly parent_id: UUIDv7 | null;
  readonly name: string;
  readonly max_usages: number;
  readonly trial_duration_sec: number;
  /** Minimum gap between successive trials of this template against the same fingerprint. Added in v0002. */
  readonly trial_cooldown_sec: number | null;
  readonly grace_duration_sec: number;
  readonly force_online_after_sec: number | null;
  readonly entitlements: Readonly<Record<string, JSONValue>>;
  readonly meta: Readonly<Record<string, JSONValue>>;
}

export interface LicenseUsageInput {
  readonly license_id: UUIDv7;
  readonly fingerprint: string;
  readonly status: UsageStatus;
  readonly registered_at: string;
  readonly revoked_at: string | null;
  readonly client_meta: Readonly<Record<string, JSONValue>>;
}

export interface LicenseKeyInput {
  readonly scope_id: UUIDv7 | null;
  readonly kid: string;
  readonly alg: KeyAlg;
  readonly role: KeyRole;
  readonly state: KeyState;
  readonly public_pem: string;
  readonly private_pem_enc: string | null;
  readonly rotated_from: UUIDv7 | null;
  readonly rotated_at: string | null;
  readonly not_before: string;
  readonly not_after: string | null;
  readonly meta: Readonly<Record<string, JSONValue>>;
}

export interface AuditLogInput {
  readonly license_id: UUIDv7 | null;
  readonly scope_id: UUIDv7 | null;
  readonly actor: string;
  readonly event: string;
  readonly prior_state: Readonly<Record<string, JSONValue>> | null;
  readonly new_state: Readonly<Record<string, JSONValue>> | null;
  readonly occurred_at: string;
}

// ---------- Patch shapes (partial updates) ----------

/** Mutable subset of License. Natural keys and storage-managed fields excluded. */
export interface LicensePatch {
  readonly status?: LicenseStatus;
  readonly max_usages?: number;
  readonly activated_at?: string | null;
  readonly expires_at?: string | null;
  readonly grace_until?: string | null;
  readonly meta?: Readonly<Record<string, JSONValue>>;
  readonly scope_id?: UUIDv7 | null;
  readonly template_id?: UUIDv7 | null;
}

export interface LicenseScopePatch {
  readonly name?: string;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface LicenseTemplatePatch {
  readonly name?: string;
  /** Re-parent or detach a template. Cycles are rejected at write time. */
  readonly parent_id?: UUIDv7 | null;
  readonly max_usages?: number;
  readonly trial_duration_sec?: number;
  readonly trial_cooldown_sec?: number | null;
  readonly grace_duration_sec?: number;
  readonly force_online_after_sec?: number | null;
  readonly entitlements?: Readonly<Record<string, JSONValue>>;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

export interface LicenseUsagePatch {
  readonly status?: UsageStatus;
  readonly revoked_at?: string | null;
  readonly client_meta?: Readonly<Record<string, JSONValue>>;
}

export interface LicenseKeyPatch {
  readonly state?: KeyState;
  readonly rotated_from?: UUIDv7 | null;
  readonly rotated_at?: string | null;
  readonly not_after?: string | null;
  readonly meta?: Readonly<Record<string, JSONValue>>;
}

// ---------- List filters + pagination ----------

export interface PageRequest {
  /** Max rows to return. Adapters MAY cap this; typical cap is 500. */
  readonly limit: number;
  /** Opaque cursor from a prior page. Omit/null to fetch the first page. */
  readonly cursor?: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Null when the caller has reached the end of the result set. */
  readonly cursor: string | null;
}

export interface LicenseFilter {
  readonly scope_id?: UUIDv7 | null;
  readonly status?: readonly LicenseStatus[];
  readonly licensable_type?: string;
  readonly licensable_id?: string;
  readonly template_id?: UUIDv7 | null;
}

export interface LicenseScopeFilter {
  readonly slug?: string;
}

export interface LicenseTemplateFilter {
  readonly scope_id?: UUIDv7 | null;
  readonly name?: string;
  /** Restrict to templates with the given parent. NULL filters root templates. */
  readonly parent_id?: UUIDv7 | null;
}

export interface LicenseUsageFilter {
  readonly license_id?: UUIDv7;
  readonly fingerprint?: string;
  readonly status?: readonly UsageStatus[];
}

export interface LicenseKeyFilter {
  readonly scope_id?: UUIDv7 | null;
  readonly kid?: string;
  readonly alg?: KeyAlg;
  readonly role?: KeyRole;
  readonly state?: KeyState;
}

export interface AuditLogFilter {
  readonly license_id?: UUIDv7 | null;
  readonly scope_id?: UUIDv7 | null;
  readonly event?: string;
}

// ---------- Schema-parity accessor ----------

/** A single column in the canonical entity schema. Matches a row in
 *  `fixtures/schema/entities.md`. */
export interface SchemaColumn {
  readonly name: string;
  /** Type category — not the adapter-native SQL type. One of:
   *  `uuid`, `string`, `int`, `timestamp`, `json`, `enum`, `text`, `bool`. */
  readonly type: 'uuid' | 'string' | 'int' | 'timestamp' | 'json' | 'enum' | 'text' | 'bool';
  readonly nullable: boolean;
  /** Member of a unique constraint. For composite uniques, the constraint
   *  name(s) this column participates in. Empty for non-unique columns. */
  readonly unique: readonly string[];
}

export interface SchemaEntity {
  readonly name:
    | 'License'
    | 'LicenseScope'
    | 'LicenseTemplate'
    | 'LicenseUsage'
    | 'LicenseKey'
    | 'AuditLog'
    | 'TrialIssuance';
  readonly columns: readonly SchemaColumn[];
}

export type SchemaDescription = readonly SchemaEntity[];

// ---------- The interface itself ----------

/** Transaction handle passed into `withTransaction(fn)`. Same surface as
 *  {@link Storage} except `withTransaction` is absent (no nesting).
 *
 *  Adapters MAY surface extra driver-native affordances on the handle (e.g.
 *  a Postgres client for raw SQL); consumers of the interface MUST NOT rely
 *  on anything beyond what's declared here. */
export type StorageTx = Omit<Storage, 'withTransaction'>;

/** Query argument for {@link Storage.findLicensesByLicensable}. */
export interface FindByLicensableQuery {
  readonly type: string;
  readonly id: string;
  /** When set, restrict to a specific scope (or `null` for global-scope only).
   *  When omitted, returns matches in every scope. */
  readonly scope_id?: UUIDv7 | null;
}

export interface Storage {
  // ---------- Licenses ----------
  createLicense(input: LicenseInput): Promise<License>;
  getLicense(id: UUIDv7): Promise<License | null>;
  getLicenseByKey(licenseKey: string): Promise<License | null>;
  listLicenses(filter: LicenseFilter, page: PageRequest): Promise<Page<License>>;
  /**
   * Return every license attached to the given polymorphic licensable,
   * ordered by `created_at DESC`. Bounded in practice by the
   * `(licensable_type, licensable_id, scope_id)` unique constraint —
   * each licensable holds at most one license per scope, so callers
   * see at most one row per scope.
   *
   * Uses the `licenses_licensable_type_id_idx` introduced in v0002.
   * Added in v0002.
   */
  findLicensesByLicensable(query: FindByLicensableQuery): Promise<readonly License[]>;
  updateLicense(id: UUIDv7, patch: LicensePatch): Promise<License>;

  // ---------- LicenseScopes ----------
  createScope(input: LicenseScopeInput): Promise<LicenseScope>;
  getScope(id: UUIDv7): Promise<LicenseScope | null>;
  getScopeBySlug(slug: string): Promise<LicenseScope | null>;
  listScopes(filter: LicenseScopeFilter, page: PageRequest): Promise<Page<LicenseScope>>;
  updateScope(id: UUIDv7, patch: LicenseScopePatch): Promise<LicenseScope>;

  // ---------- LicenseTemplates ----------
  createTemplate(input: LicenseTemplateInput): Promise<LicenseTemplate>;
  getTemplate(id: UUIDv7): Promise<LicenseTemplate | null>;
  listTemplates(filter: LicenseTemplateFilter, page: PageRequest): Promise<Page<LicenseTemplate>>;
  updateTemplate(id: UUIDv7, patch: LicenseTemplatePatch): Promise<LicenseTemplate>;

  // ---------- LicenseUsages ----------
  createUsage(input: LicenseUsageInput): Promise<LicenseUsage>;
  getUsage(id: UUIDv7): Promise<LicenseUsage | null>;
  listUsages(filter: LicenseUsageFilter, page: PageRequest): Promise<Page<LicenseUsage>>;
  updateUsage(id: UUIDv7, patch: LicenseUsagePatch): Promise<LicenseUsage>;

  // ---------- LicenseKeys (signing key storage) ----------
  createKey(input: LicenseKeyInput): Promise<LicenseKey>;
  getKey(id: UUIDv7): Promise<LicenseKey | null>;
  getKeyByKid(kid: string): Promise<LicenseKey | null>;
  listKeys(filter: LicenseKeyFilter, page: PageRequest): Promise<Page<LicenseKey>>;
  updateKey(id: UUIDv7, patch: LicenseKeyPatch): Promise<LicenseKey>;

  // ---------- AuditLog (append-only) ----------
  appendAudit(input: AuditLogInput): Promise<AuditLogEntry>;
  getAudit(id: UUIDv7): Promise<AuditLogEntry | null>;
  listAudit(filter: AuditLogFilter, page: PageRequest): Promise<Page<AuditLogEntry>>;

  // ---------- Transactions & schema introspection ----------
  /** Run `fn` atomically. A thrown error MUST roll back every write made
   *  via `tx`. Successful return commits. Nested calls are not supported. */
  withTransaction<T>(fn: (tx: StorageTx) => Promise<T>): Promise<T>;

  /** Return the adapter's view of the canonical schema. The returned
   *  {@link SchemaDescription} is compared against the parsed
   *  `fixtures/schema/entities.md` in the schema-parity test. */
  describeSchema(): SchemaDescription;

  /** Optional shutdown hook (close pools, flush writes). Adapters that
   *  hold no resources MAY no-op. */
  close?(): Promise<void>;
}
