package licensing

// Entity types for the licensing domain. Mirror
// typescript/packages/core/src/types.ts byte-for-byte in JSON
// representation — storage adapters (memory / postgres / sqlite) rely on
// these structs; cross-language interop depends on identical on-the-wire
// shape (field names, nullability, timestamp format).
//
// Timestamps are ISO-8601 / RFC 3339 strings with microsecond precision
// (Go's time.RFC3339Nano is a superset of what the TS emitter uses; the
// storage adapters truncate to microseconds when persisting).

// ---------- enums ----------

// LicenseStatus is the License lifecycle state discriminator.
type LicenseStatus string

// LicenseStatus values. Must stay in lockstep with the TS emitter and
// the `licensing.LicenseStatus` enum surfaced over the wire.
const (
	LicenseStatusPending   LicenseStatus = "pending"
	LicenseStatusActive    LicenseStatus = "active"
	LicenseStatusGrace     LicenseStatus = "grace"
	LicenseStatusExpired   LicenseStatus = "expired"
	LicenseStatusSuspended LicenseStatus = "suspended"
	LicenseStatusRevoked   LicenseStatus = "revoked"
)

// UsageStatus is the LicenseUsage (seat) state discriminator.
type UsageStatus string

// UsageStatus values. A usage (seat) is either live ("active") or
// permanently retired ("revoked") — there is no suspended-seat state.
const (
	UsageStatusActive  UsageStatus = "active"
	UsageStatusRevoked UsageStatus = "revoked"
)

// KeyRole tags a key's position in the hierarchy. Root keys certify signing
// keys via attestations; signing keys actually sign LIC1 tokens.
type KeyRole string

// KeyRole values.
const (
	RoleRoot    KeyRole = "root"
	RoleSigning KeyRole = "signing"
)

// KeyState is the rotation state of a signing key. Root keys are always
// active; they retire by being deleted.
type KeyState string

// KeyState values. Retiring keys still verify tokens (until retire_at)
// but no longer sign new ones — see docs/token-format.md § key rotation.
const (
	StateActive   KeyState = "active"
	StateRetiring KeyState = "retiring"
)

// ---------- core entities ----------

// License is the top-level licensing unit. `license_key` is the
// public-facing natural key; the storage adapter enforces uniqueness.
type License struct {
	ActivatedAt    *string        `json:"activated_at"`
	ScopeID        *string        `json:"scope_id"`
	TemplateID     *string        `json:"template_id"`
	Meta           map[string]any `json:"meta"`
	GraceUntil     *string        `json:"grace_until"`
	ExpiresAt      *string        `json:"expires_at"`
	LicensableType string         `json:"licensable_type"`
	Status         LicenseStatus  `json:"status"`
	LicenseKey     string         `json:"license_key"`
	LicensableID   string         `json:"licensable_id"`
	ID             string         `json:"id"`
	CreatedAt      string         `json:"created_at"`
	UpdatedAt      string         `json:"updated_at"`
	MaxUsages      int            `json:"max_usages"`
	// IsTrial mirrors the `trial: true` claim on trial-issued tokens. Added in v0002.
	IsTrial bool `json:"is_trial"`
}

// LicenseScope is a tenant / product partition. Licenses, templates, and
// keys may be scoped; a nil scope_id means "global."
type LicenseScope struct {
	ID        string         `json:"id"`
	Slug      string         `json:"slug"`
	Name      string         `json:"name"`
	Meta      map[string]any `json:"meta"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

// LicenseTemplate captures default policy (max_usages, trial/grace
// durations, force-online interval, entitlements) applied when a License
// is minted from it.
type LicenseTemplate struct {
	ScopeID             *string        `json:"scope_id"`
	ParentID            *string        `json:"parent_id"`
	ForceOnlineAfterSec *int           `json:"force_online_after_sec"`
	TrialCooldownSec    *int           `json:"trial_cooldown_sec"`
	Entitlements        map[string]any `json:"entitlements"`
	Meta                map[string]any `json:"meta"`
	ID                  string         `json:"id"`
	Name                string         `json:"name"`
	CreatedAt           string         `json:"created_at"`
	UpdatedAt           string         `json:"updated_at"`
	MaxUsages           int            `json:"max_usages"`
	TrialDurationSec    int            `json:"trial_duration_sec"`
	GraceDurationSec    int            `json:"grace_duration_sec"`
}

// LicenseUsage is a single seat / device registration under a License.
// Uniqueness is (license_id, fingerprint) — the same fingerprint can
// register under multiple licenses.
type LicenseUsage struct {
	ID           string         `json:"id"`
	LicenseID    string         `json:"license_id"`
	Fingerprint  string         `json:"fingerprint"`
	Status       UsageStatus    `json:"status"`
	RegisteredAt string         `json:"registered_at"`
	RevokedAt    *string        `json:"revoked_at"`
	ClientMeta   map[string]any `json:"client_meta"`
	CreatedAt    string         `json:"created_at"`
	UpdatedAt    string         `json:"updated_at"`
}

// LicenseKey mirrors typescript/packages/core/src/types.ts LicenseKey.
// Timestamps are ISO-8601 strings to match the TS wire format exactly;
// interop tests rely on byte-identical JSON.
type LicenseKey struct {
	ID            string         `json:"id"`
	ScopeID       *string        `json:"scope_id"`
	Kid           string         `json:"kid"`
	Alg           KeyAlg         `json:"alg"`
	Role          KeyRole        `json:"role"`
	State         KeyState       `json:"state"`
	PublicPem     string         `json:"public_pem"`
	PrivatePemEnc *string        `json:"private_pem_enc"`
	RotatedFrom   *string        `json:"rotated_from"`
	RotatedAt     *string        `json:"rotated_at"`
	NotBefore     string         `json:"not_before"`
	NotAfter      *string        `json:"not_after"`
	Meta          map[string]any `json:"meta"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
}

// AuditLogEntry is append-only. Adapters enforce immutability adapter-side
// (not in a wrapper) and reject UPDATE/DELETE with ImmutableAuditLog.
type AuditLogEntry struct {
	ID         string         `json:"id"`
	LicenseID  *string        `json:"license_id"`
	ScopeID    *string        `json:"scope_id"`
	Actor      string         `json:"actor"`
	Event      string         `json:"event"`
	PriorState map[string]any `json:"prior_state"`
	NewState   map[string]any `json:"new_state"`
	OccurredAt string         `json:"occurred_at"`
}

// ---------- Input shapes (caller-supplied; storage-managed fields omitted) ----------

// LicenseInput is the caller-supplied shape for creating a License.
// Storage-managed fields (`id`, `created_at`, `updated_at`) are populated
// by the adapter; supplying them in input is tolerated but MUST be ignored.
type LicenseInput struct {
	ScopeID        *string
	TemplateID     *string
	ActivatedAt    *string
	ExpiresAt      *string
	GraceUntil     *string
	Meta           map[string]any
	LicensableType string
	LicensableID   string
	LicenseKey     string
	Status         LicenseStatus
	MaxUsages      int
}

// LicenseScopeInput is the tx-level Create input for a LicenseScope.
type LicenseScopeInput struct {
	Meta map[string]any
	Slug string
	Name string
}

// LicenseTemplateInput is the tx-level Create input for a LicenseTemplate.
type LicenseTemplateInput struct {
	ScopeID             *string
	ForceOnlineAfterSec *int
	Entitlements        map[string]any
	Meta                map[string]any
	Name                string
	MaxUsages           int
	TrialDurationSec    int
	GraceDurationSec    int
}

// LicenseUsageInput is the tx-level Create input for a LicenseUsage (seat).
type LicenseUsageInput struct {
	RevokedAt    *string
	ClientMeta   map[string]any
	LicenseID    string
	Fingerprint  string
	Status       UsageStatus
	RegisteredAt string
}

// LicenseKeyInput is the tx-level Create input for a LicenseKey record.
// `PrivatePemEnc` is the encrypted-at-rest PEM; plaintext never lands here.
type LicenseKeyInput struct {
	ScopeID       *string
	PrivatePemEnc *string
	RotatedFrom   *string
	RotatedAt     *string
	NotAfter      *string
	Meta          map[string]any
	Kid           string
	Alg           KeyAlg
	Role          KeyRole
	State         KeyState
	PublicPem     string
	NotBefore     string
}

// AuditLogInput is the tx-level append input for an audit row. The log is
// append-only — adapters reject updates/deletes at the storage layer.
type AuditLogInput struct {
	LicenseID  *string
	ScopeID    *string
	Actor      string
	Event      string
	PriorState map[string]any
	NewState   map[string]any
	OccurredAt string
}

// ---------- Patch shapes (partial updates) ----------
//
// Pointer semantics are used to distinguish "field not supplied" (nil
// pointer) from "field supplied as zero / null" (pointer to zero value).
// For nullable fields that take `*string`, we wrap in OptString to
// distinguish "not supplied" from "set to null".

// OptString carries a nullable-string patch. Set = false means "field
// not in the patch"; Set = true means "field is supplied" and Value may
// be nil to write NULL.
type OptString struct {
	Value *string
	Set   bool
}

// OptInt mirrors OptString for nullable int fields.
type OptInt struct {
	Value *int
	Set   bool
}

// OptJSON mirrors OptString for JSON object fields.
type OptJSON struct {
	Value map[string]any
	Set   bool
}

// LicensePatch describes a partial update of a License. All fields are
// optional; unique natural keys (`license_key`) are never patchable.
type LicensePatch struct {
	Status      *LicenseStatus
	MaxUsages   *int
	ActivatedAt OptString
	ExpiresAt   OptString
	GraceUntil  OptString
	Meta        OptJSON
	ScopeID     OptString
	TemplateID  OptString
}

// LicenseScopePatch is the partial-update shape for LicenseScope.
type LicenseScopePatch struct {
	Name *string
	Meta OptJSON
}

// LicenseTemplatePatch is the partial-update shape for LicenseTemplate.
type LicenseTemplatePatch struct {
	Name                *string
	MaxUsages           *int
	TrialDurationSec    *int
	GraceDurationSec    *int
	ForceOnlineAfterSec OptInt
	Entitlements        OptJSON
	Meta                OptJSON
}

// LicenseUsagePatch is the partial-update shape for LicenseUsage.
type LicenseUsagePatch struct {
	Status     *UsageStatus
	RevokedAt  OptString
	ClientMeta OptJSON
}

// LicenseKeyPatch is the partial-update shape for LicenseKey. The private
// PEM and public PEM are never patchable — rotation is a distinct flow.
type LicenseKeyPatch struct {
	State       *KeyState
	RotatedFrom OptString
	RotatedAt   OptString
	NotAfter    OptString
	Meta        OptJSON
}

// ---------- List filters ----------

// LicenseFilter narrows listLicenses results. ScopeIDSet distinguishes
// "don't filter" from "filter on nil (global) scope."
type LicenseFilter struct {
	ScopeID        *string
	LicensableType *string
	LicensableID   *string
	TemplateID     *string
	Status         []LicenseStatus
	ScopeIDSet     bool
	TemplateIDSet  bool
}

// LicenseScopeFilter narrows ListScopes results.
type LicenseScopeFilter struct {
	Slug *string
}

// LicenseTemplateFilter narrows ListTemplates results. ScopeIDSet
// distinguishes "don't filter on scope" from "filter on nil (global) scope."
type LicenseTemplateFilter struct {
	ScopeID    *string
	Name       *string
	ScopeIDSet bool
}

// LicenseUsageFilter narrows ListUsages results.
type LicenseUsageFilter struct {
	LicenseID   *string
	Fingerprint *string
	Status      []UsageStatus
}

// LicenseKeyFilter narrows listKeys / KeyStore.List results. Same
// ScopeIDSet semantics as LicenseFilter.
type LicenseKeyFilter struct {
	ScopeID    *string
	Kid        *string
	Alg        *KeyAlg
	Role       *KeyRole
	State      *KeyState
	ScopeIDSet bool
}

// AuditLogFilter narrows ListAudits results. The *Set fields distinguish
// "don't filter" from "filter on nil" for the nullable pointer columns.
type AuditLogFilter struct {
	LicenseID    *string
	ScopeID      *string
	Event        *string
	LicenseIDSet bool
	ScopeIDSet   bool
}
