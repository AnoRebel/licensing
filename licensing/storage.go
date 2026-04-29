package licensing

// Storage contract for the licensing domain. Every adapter under
// licensing/storage/{memory,postgres,sqlite} implements Storage; the core
// lifecycle and state-machine code depends only on this interface, never on
// a specific adapter.
//
// Mirrors typescript/packages/core/src/storage/types.ts. Contract anchors:
//
//	Spec:  openspec/changes/port-laravel-licensing-to-ts-and-go/specs/licensing-storage/spec.md
//	Schema: fixtures/schema/entities.md
//
// Design notes
//
//  1. Inputs are *Input shapes — they omit storage-managed fields (`id`,
//     `created_at`, `updated_at`). The adapter populates them. Supplying
//     them in input is tolerated but MUST be ignored per entities.md §7.
//
//  2. Updates use *Patch shapes keyed by id. Only mutable fields are in the
//     patch; unique natural keys (`license_key`, `slug`, `kid`,
//     `fingerprint`) are never updatable. Patch pointer semantics: a nil
//     pointer means "field not in the patch"; a non-nil pointer means
//     "apply". Nullable fields use Opt* wrappers so "set to NULL" is
//     distinguishable from "not supplied" — see entities.go.
//
//  3. Lists always return a Page + opaque cursor. A nil cursor means the
//     caller has reached the end. Cursors are adapter-specific but the
//     opacity contract is universal: callers pass the previous page's
//     cursor back verbatim to fetch the next one.
//
//  4. WithTransaction is the sole primitive that crosses rows within an
//     atomic unit. The memory adapter implements it via snapshot +
//     commit-on-success; Postgres/SQLite use native BEGIN/COMMIT. Errors
//     returned from `fn` MUST roll back the snapshot; the outer Storage
//     returns that same error unchanged.
//
//  5. AuditLog is write-once. Adapters MUST reject UPDATE/DELETE with
//     CodeImmutableAuditLog enforced adapter-side (not in a wrapper).
//
//  6. "Not found" is modelled as a nil pointer return with nil error.
//     Adapters MUST NOT surface a domain error for simple misses — callers
//     branch on nil. Actual failures (I/O, constraint violations) return
//     (nil, *Error).

// ---------- Pagination ----------

// PageRequest narrows a list call. Adapters MAY cap the effective limit
// (typical cap: 500); they MUST document the cap in their adapter doc and
// apply it silently rather than erroring.
type PageRequest struct {
	Cursor string
	Limit  int
}

// Page is a single page of a listing. Cursor == "" signals "end of result
// set" — the caller has seen every row. A non-empty Cursor is the token to
// pass to the next PageRequest to continue.
type Page[T any] struct {
	Cursor string
	Items  []T
}

// ---------- Schema introspection ----------

// SchemaColumnType is the canonical type category used across all adapters.
// It is NOT the adapter-native SQL type (Postgres uses `uuid`, `text`,
// `jsonb`; SQLite uses affinity; memory uses Go types). The schema-parity
// test compares adapters against these categories to ensure everyone
// agrees on the same logical shape.
type SchemaColumnType string

// SchemaColumnType values. Canonical categories; adapters map these to
// their native SQL types. The schema-parity test enforces that every
// adapter agrees on the category for each column.
const (
	SchemaColUUID      SchemaColumnType = "uuid"
	SchemaColString    SchemaColumnType = "string"
	SchemaColInt       SchemaColumnType = "int"
	SchemaColTimestamp SchemaColumnType = "timestamp"
	SchemaColJSON      SchemaColumnType = "json"
	SchemaColEnum      SchemaColumnType = "enum"
	SchemaColText      SchemaColumnType = "text"
	// SchemaColBool is the `bool` type category (added in v0002 for licenses.is_trial).
	SchemaColBool SchemaColumnType = "bool"
)

// SchemaColumn describes one column of the canonical entity schema.
type SchemaColumn struct {
	Name     string
	Type     SchemaColumnType
	Unique   []string
	Nullable bool
}

// SchemaEntityName enumerates the top-level entities. The values are the
// canonical names used in fixtures/schema/entities.md.
type SchemaEntityName string

// SchemaEntityName values. Must match the entity names in
// fixtures/schema/entities.md exactly — the parity test compares strings.
const (
	SchemaEntLicense         SchemaEntityName = "License"
	SchemaEntLicenseScope    SchemaEntityName = "LicenseScope"
	SchemaEntLicenseTemplate SchemaEntityName = "LicenseTemplate"
	SchemaEntLicenseUsage    SchemaEntityName = "LicenseUsage"
	SchemaEntLicenseKey      SchemaEntityName = "LicenseKey"
	SchemaEntAuditLog        SchemaEntityName = "AuditLog"
	// SchemaEntTrialIssuance enumerates per-template trial dedupe rows (added in v0002).
	SchemaEntTrialIssuance SchemaEntityName = "TrialIssuance"
)

// SchemaEntity is one table / collection in the canonical schema.
type SchemaEntity struct {
	Name    SchemaEntityName
	Columns []SchemaColumn
}

// SchemaDescription is the adapter's view of the canonical schema,
// compared in the parity test against parsed fixtures/schema/entities.md.
type SchemaDescription []SchemaEntity

// FindByLicensableQuery is the lookup-by-licensable query for
// StorageTx.FindLicensesByLicensable. Type and ID are required;
// ScopeID + ScopeIDSet follow the same "set means filter" convention
// used by LicenseFilter (ScopeIDSet=false: all scopes; ScopeIDSet=true
// with ScopeID=nil: global scope only).
type FindByLicensableQuery struct {
	ScopeID    *string
	Type       string
	ID         string
	ScopeIDSet bool
}

// ---------- The Storage interface ----------

// StorageTx is the transaction handle passed into Storage.WithTransaction.
// Same read/write surface as Storage minus WithTransaction itself (no
// nesting). Adapters MAY surface extra driver-native affordances on a
// concrete *adapter.Tx type (e.g. a pgx.Tx for raw SQL), but consumers of
// this interface MUST NOT rely on anything beyond what's declared here —
// otherwise the core stops being adapter-agnostic.
type StorageTx interface {
	// ---------- Licenses ----------
	CreateLicense(input LicenseInput) (*License, error)
	GetLicense(id string) (*License, error)
	GetLicenseByKey(licenseKey string) (*License, error)
	ListLicenses(filter LicenseFilter, page PageRequest) (Page[License], error)
	// FindLicensesByLicensable returns every license matching the given
	// polymorphic attachment (licensable_type, licensable_id), ordered by
	// created_at DESC. Bounded in practice by the
	// (licensable_type, licensable_id, scope_id) unique constraint —
	// each licensable holds at most one license per scope. Uses the
	// licenses_licensable_type_id_idx introduced in v0002.
	FindLicensesByLicensable(query FindByLicensableQuery) ([]License, error)
	UpdateLicense(id string, patch LicensePatch) (*License, error)
	// DeleteLicense hard-deletes a license row. Adapters MUST surface
	// CodeLicenseNotFound when no row matches, and CodeUniqueConstraintViolation
	// when the caller attempts to delete a license that still has active
	// usages — the admin handler maps that to HTTP 409. Audit-log rows that
	// reference the license id MUST be preserved (audit is write-once).
	DeleteLicense(id string) error

	// ---------- LicenseScopes ----------
	CreateScope(input LicenseScopeInput) (*LicenseScope, error)
	GetScope(id string) (*LicenseScope, error)
	GetScopeBySlug(slug string) (*LicenseScope, error)
	ListScopes(filter LicenseScopeFilter, page PageRequest) (Page[LicenseScope], error)
	UpdateScope(id string, patch LicenseScopePatch) (*LicenseScope, error)
	// DeleteScope hard-deletes a scope row. Adapters MUST surface
	// CodeLicenseNotFound on miss and CodeUniqueConstraintViolation when any
	// license or template still references the scope (caller unlinks first).
	DeleteScope(id string) error

	// ---------- LicenseTemplates ----------
	CreateTemplate(input LicenseTemplateInput) (*LicenseTemplate, error)
	GetTemplate(id string) (*LicenseTemplate, error)
	ListTemplates(filter LicenseTemplateFilter, page PageRequest) (Page[LicenseTemplate], error)
	UpdateTemplate(id string, patch LicenseTemplatePatch) (*LicenseTemplate, error)
	// DeleteTemplate hard-deletes a template row. Adapters MUST surface
	// CodeLicenseNotFound on miss and CodeUniqueConstraintViolation when any
	// license still references the template.
	DeleteTemplate(id string) error

	// ---------- LicenseUsages (seats) ----------
	//
	// Adapters MUST enforce (license_id, fingerprint) uniqueness and MUST
	// surface CodeUniqueConstraintViolation on conflict — the state
	// machine depends on the error code (not the adapter's native
	// message) to make retry / "already-registered" decisions.
	CreateUsage(input LicenseUsageInput) (*LicenseUsage, error)
	GetUsage(id string) (*LicenseUsage, error)
	ListUsages(filter LicenseUsageFilter, page PageRequest) (Page[LicenseUsage], error)
	UpdateUsage(id string, patch LicenseUsagePatch) (*LicenseUsage, error)

	// ---------- LicenseKeys (signing key storage) ----------
	CreateKey(input LicenseKeyInput) (*LicenseKey, error)
	GetKey(id string) (*LicenseKey, error)
	GetKeyByKid(kid string) (*LicenseKey, error)
	ListKeys(filter LicenseKeyFilter, page PageRequest) (Page[LicenseKey], error)
	UpdateKey(id string, patch LicenseKeyPatch) (*LicenseKey, error)

	// ---------- AuditLog (append-only) ----------
	//
	// Adapters MUST forbid UPDATE and DELETE at the storage layer and
	// surface CodeImmutableAuditLog. Any code path that currently writes
	// to the audit log relies on this invariant to prove tamper-evidence.
	AppendAudit(input AuditLogInput) (*AuditLogEntry, error)
	GetAudit(id string) (*AuditLogEntry, error)
	ListAudit(filter AuditLogFilter, page PageRequest) (Page[AuditLogEntry], error)

	// ---------- TrialIssuances (added in v0002) ----------
	//
	// RecordTrialIssuance writes a row pinning (template_id, fingerprint_hash)
	// at issuance time. The unique constraint on (template_id, fingerprint_hash)
	// rejects same-pair duplicates with CodeUniqueConstraintViolation; per-
	// template cooldown enforcement sits one layer above this method.
	//
	// FindTrialIssuance returns the most recent row for the pair, or nil.
	// DeleteTrialIssuance hard-deletes by id (admin "Reset trial" action).
	RecordTrialIssuance(input TrialIssuanceInput) (*TrialIssuance, error)
	FindTrialIssuance(query TrialIssuanceLookup) (*TrialIssuance, error)
	DeleteTrialIssuance(id string) error
}

// Storage is the full adapter contract. In addition to everything on
// StorageTx, it exposes the transactional entry point and schema
// introspection.
type Storage interface {
	StorageTx

	// WithTransaction runs fn inside an atomic unit. If fn returns an
	// error, every write made via tx MUST be rolled back and the same
	// error MUST be returned to the caller, unwrapped. On nil return, the
	// transaction commits and the result value is returned.
	//
	// Nesting is not supported: calling WithTransaction from inside fn
	// MUST panic or error (adapter's choice) rather than silently
	// degrading to a savepoint.
	WithTransaction(fn func(tx StorageTx) error) error

	// DescribeSchema returns the adapter's view of the canonical schema.
	// Compared against parsed fixtures/schema/entities.md in the
	// schema-parity conformance test. Adapters MUST return the SAME
	// description across calls — this is read-only introspection, not
	// a live query.
	DescribeSchema() SchemaDescription

	// Close releases any resources held by the adapter (connection pools,
	// file handles). Adapters that hold no resources MAY implement it as a
	// no-op that returns nil.
	Close() error
}
