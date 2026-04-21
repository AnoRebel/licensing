package sqlite

import (
	"strings"

	lic "github.com/AnoRebel/licensing/licensing"
)

// constraintNameLookup maps "table:col1,col2" to the canonical
// constraint name used by both the Postgres and SQLite adapters.
// This is the bridge between SQLite's "UNIQUE constraint failed:
// table.col" error messages and the domain error taxonomy.
var constraintNameLookup = map[string]string{
	"licenses:license_key":                            "licenses_license_key_key",
	"licenses:licensable_type,licensable_id,scope_id": "licenses_scoped_triple_key",
	"licenses:licensable_type,licensable_id":          "licenses_global_pair_key",
	"license_scopes:slug":                             "license_scopes_slug_key",
	"license_templates:scope_id,name":                 "license_templates_scope_name_key",
	"license_templates:name":                          "license_templates_global_name_key",
	"license_usages:license_id,fingerprint":           "license_usages_active_fp_key",
	"license_keys:kid":                                "license_keys_kid_key",
	"license_keys:scope_id":                           "license_keys_active_signing_scoped_key",
	"license_keys:role":                               "license_keys_active_signing_global_key",
}

// parseUniqueFailure extracts table and column names from a SQLite
// "UNIQUE constraint failed: table.col1, table.col2" message.
func parseUniqueFailure(msg string) (table string, columns []string, ok bool) {
	const prefix = "UNIQUE constraint failed: "
	idx := strings.Index(msg, prefix)
	if idx < 0 {
		return "", nil, false
	}
	rest := msg[idx+len(prefix):]
	// modernc.org/sqlite appends " (NNNN)" error codes — strip them.
	if lp := strings.LastIndex(rest, " ("); lp > 0 {
		rest = rest[:lp]
	}
	parts := strings.Split(rest, ",")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		dot := strings.IndexByte(p, '.')
		if dot < 0 {
			return "", nil, false
		}
		if table == "" {
			table = p[:dot]
		}
		columns = append(columns, p[dot+1:])
	}
	return table, columns, len(columns) > 0
}

// mapSqliteError translates a SQLite error into the licensing domain
// error taxonomy. Unmatched errors are returned untouched.
func mapSqliteError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()

	// Unique constraint failures.
	if strings.Contains(msg, "UNIQUE constraint failed") {
		table, columns, ok := parseUniqueFailure(msg)
		if ok {
			key := table + ":" + strings.Join(columns, ",")
			constraint := constraintNameLookup[key]

			switch constraint {
			case "licenses_license_key_key":
				return lic.NewError(lic.CodeLicenseKeyConflict,
					"duplicate license key", nil)

			case "licenses_scoped_triple_key", "licenses_global_pair_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"licensable_scope: "+strings.Join(columns, ","),
					map[string]any{"constraint": "licensable_scope"})

			case "license_scopes_slug_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"slug: "+strings.Join(columns, ","),
					map[string]any{"constraint": "slug"})

			case "license_templates_scope_name_key", "license_templates_global_name_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"scope_name: "+strings.Join(columns, ","),
					map[string]any{"constraint": "scope_name"})

			case "license_usages_active_fp_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"license_fingerprint_active: "+strings.Join(columns, ","),
					map[string]any{"constraint": "license_fingerprint_active"})

			case "license_keys_kid_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"kid: "+strings.Join(columns, ","),
					map[string]any{"constraint": "kid"})

			case "license_keys_active_signing_scoped_key", "license_keys_active_signing_global_key":
				return lic.NewError(lic.CodeUniqueConstraintViolation,
					"scope_active_signing: "+strings.Join(columns, ","),
					map[string]any{"constraint": "scope_active_signing"})
			}

			// Unknown constraint — surface generically.
			name := constraint
			if name == "" {
				name = table + "." + strings.Join(columns, ",")
			}
			return lic.NewError(lic.CodeUniqueConstraintViolation,
				name+": "+strings.Join(columns, ","),
				map[string]any{"constraint": name})
		}
	}

	// AuditLog immutability trigger.
	if strings.Contains(msg, "ImmutableAuditLog") {
		return lic.NewError(lic.CodeImmutableAuditLog,
			"audit rows are append-only", nil)
	}

	return err
}
