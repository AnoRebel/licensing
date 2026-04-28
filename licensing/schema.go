package licensing

// CanonicalSchema is the single source of truth for the licensing
// entity schema. Every Storage adapter returns this exact description
// from its DescribeSchema() method — a conformance test asserts parity
// against fixtures/schema/entities.md.
//
// When the canonical schema changes, update BOTH:
//  1. fixtures/schema/entities.md (the canonical source)
//  2. this function
//
// Shared constants reduce the chance that one adapter drifts from
// another; drift would only surface in CI when the cross-language
// interop tests run, which is too late.

// CanonicalSchema returns the adapters' view of the canonical schema.
// It allocates on every call to preserve the Storage contract's
// immutability — callers that append to the returned slice will not
// corrupt a shared cache.
func CanonicalSchema() SchemaDescription {
	pk := []string{"pk"}
	return SchemaDescription{
		// ---------- License ----------
		{
			Name: SchemaEntLicense,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "scope_id", Type: SchemaColUUID, Nullable: true, Unique: []string{"licensable_scope"}},
				{Name: "template_id", Type: SchemaColUUID, Nullable: true, Unique: []string{}},
				{Name: "licensable_type", Type: SchemaColString, Nullable: false, Unique: []string{"licensable_scope"}},
				{Name: "licensable_id", Type: SchemaColString, Nullable: false, Unique: []string{"licensable_scope"}},
				{Name: "license_key", Type: SchemaColString, Nullable: false, Unique: []string{"license_key"}},
				{Name: "status", Type: SchemaColEnum, Nullable: false, Unique: []string{}},
				{Name: "max_usages", Type: SchemaColInt, Nullable: false, Unique: []string{}},
				{Name: "is_trial", Type: SchemaColBool, Nullable: false, Unique: []string{}},
				{Name: "activated_at", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "expires_at", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "grace_until", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "meta", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "created_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "updated_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- LicenseScope ----------
		{
			Name: SchemaEntLicenseScope,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "slug", Type: SchemaColString, Nullable: false, Unique: []string{"slug"}},
				{Name: "name", Type: SchemaColString, Nullable: false, Unique: []string{}},
				{Name: "meta", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "created_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "updated_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- LicenseTemplate ----------
		{
			Name: SchemaEntLicenseTemplate,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "scope_id", Type: SchemaColUUID, Nullable: true, Unique: []string{"scope_name"}},
				{Name: "parent_id", Type: SchemaColUUID, Nullable: true, Unique: []string{}},
				{Name: "name", Type: SchemaColString, Nullable: false, Unique: []string{"scope_name"}},
				{Name: "max_usages", Type: SchemaColInt, Nullable: false, Unique: []string{}},
				{Name: "trial_duration_sec", Type: SchemaColInt, Nullable: false, Unique: []string{}},
				{Name: "trial_cooldown_sec", Type: SchemaColInt, Nullable: true, Unique: []string{}},
				{Name: "grace_duration_sec", Type: SchemaColInt, Nullable: false, Unique: []string{}},
				{Name: "force_online_after_sec", Type: SchemaColInt, Nullable: true, Unique: []string{}},
				{Name: "entitlements", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "meta", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "created_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "updated_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- LicenseUsage ----------
		{
			Name: SchemaEntLicenseUsage,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "license_id", Type: SchemaColUUID, Nullable: false, Unique: []string{"license_fingerprint_active"}},
				{Name: "fingerprint", Type: SchemaColString, Nullable: false, Unique: []string{"license_fingerprint_active"}},
				{Name: "status", Type: SchemaColEnum, Nullable: false, Unique: []string{}},
				{Name: "registered_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "revoked_at", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "client_meta", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "created_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "updated_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- LicenseKey ----------
		{
			Name: SchemaEntLicenseKey,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "scope_id", Type: SchemaColUUID, Nullable: true, Unique: []string{"scope_active_signing"}},
				{Name: "kid", Type: SchemaColString, Nullable: false, Unique: []string{"kid"}},
				{Name: "alg", Type: SchemaColEnum, Nullable: false, Unique: []string{}},
				{Name: "role", Type: SchemaColEnum, Nullable: false, Unique: []string{"scope_active_signing"}},
				{Name: "state", Type: SchemaColEnum, Nullable: false, Unique: []string{}},
				{Name: "public_pem", Type: SchemaColText, Nullable: false, Unique: []string{}},
				{Name: "private_pem_enc", Type: SchemaColText, Nullable: true, Unique: []string{}},
				{Name: "rotated_from", Type: SchemaColUUID, Nullable: true, Unique: []string{}},
				{Name: "rotated_at", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "not_before", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "not_after", Type: SchemaColTimestamp, Nullable: true, Unique: []string{}},
				{Name: "meta", Type: SchemaColJSON, Nullable: false, Unique: []string{}},
				{Name: "created_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
				{Name: "updated_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- AuditLog ----------
		{
			Name: SchemaEntAuditLog,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				{Name: "license_id", Type: SchemaColUUID, Nullable: true, Unique: []string{}},
				{Name: "scope_id", Type: SchemaColUUID, Nullable: true, Unique: []string{}},
				{Name: "actor", Type: SchemaColString, Nullable: false, Unique: []string{}},
				{Name: "event", Type: SchemaColString, Nullable: false, Unique: []string{}},
				{Name: "prior_state", Type: SchemaColJSON, Nullable: true, Unique: []string{}},
				{Name: "new_state", Type: SchemaColJSON, Nullable: true, Unique: []string{}},
				{Name: "occurred_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
		// ---------- TrialIssuance ----------
		{
			Name: SchemaEntTrialIssuance,
			Columns: []SchemaColumn{
				{Name: "id", Type: SchemaColUUID, Nullable: false, Unique: pk},
				// template_id and fingerprint_hash share two split partial uniques —
				// `(template_id, fingerprint_hash) WHERE template_id IS NOT NULL` and
				// `(fingerprint_hash) WHERE template_id IS NULL`. Both reduce to "this
				// pair is unique against the documented composite group", so they share
				// a single constraint name in the adapter's report.
				{Name: "template_id", Type: SchemaColUUID, Nullable: true, Unique: []string{"template_fingerprint"}},
				{Name: "fingerprint_hash", Type: SchemaColString, Nullable: false, Unique: []string{"template_fingerprint"}},
				{Name: "issued_at", Type: SchemaColTimestamp, Nullable: false, Unique: []string{}},
			},
		},
	}
}
