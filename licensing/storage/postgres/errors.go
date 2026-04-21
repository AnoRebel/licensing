package postgres

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	lic "github.com/AnoRebel/licensing/licensing"
)

// mapPgError translates a pgx error into the licensing domain error
// taxonomy. Unmatched errors are returned untouched — they're almost
// certainly bugs in the adapter's SQL, and swallowing them would hide
// the root cause.
func mapPgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}

	// Unique violation (23505). The constraint name tells us WHICH
	// uniqueness was violated.
	if pgErr.Code == "23505" {
		c := pgErr.ConstraintName
		detail := pgErr.Detail

		switch c {
		case "licenses_license_key_key":
			return lic.NewError(lic.CodeLicenseKeyConflict,
				"duplicate license key: "+detail, nil)

		case "licenses_scoped_triple_key", "licenses_global_pair_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"licensable_scope: "+detail,
				map[string]any{"constraint": "licensable_scope"})

		case "license_scopes_slug_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"slug: "+detail,
				map[string]any{"constraint": "slug"})

		case "license_templates_scope_name_key", "license_templates_global_name_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"scope_name: "+detail,
				map[string]any{"constraint": "scope_name"})

		case "license_usages_active_fp_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"license_fingerprint_active: "+detail,
				map[string]any{"constraint": "license_fingerprint_active"})

		case "license_keys_kid_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"kid: "+detail,
				map[string]any{"constraint": "kid"})

		case "license_keys_active_signing_scoped_key", "license_keys_active_signing_global_key":
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				"scope_active_signing: "+detail,
				map[string]any{"constraint": "scope_active_signing"})
		}

		// Unknown constraint — surface generically but preserve the name.
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			c+": "+detail,
			map[string]any{"constraint": c})
	}

	// AuditLog immutability trigger — migration raises P0001 with
	// "ImmutableAuditLog" prefix.
	if pgErr.Code == "P0001" && strings.Contains(pgErr.Message, "ImmutableAuditLog") {
		return lic.NewError(lic.CodeImmutableAuditLog,
			"audit rows are append-only", nil)
	}

	return err
}
