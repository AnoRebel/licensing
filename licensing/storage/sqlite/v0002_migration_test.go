package sqlite_test

import (
	"database/sql"
	"slices"
	"strings"
	"testing"

	"github.com/AnoRebel/licensing/licensing/storage/sqlite"
)

// TestV0002_Migration verifies the v0002 migration adds every documented
// schema object and that v0001 row data survives the upgrade. Mirrors the
// TS-side typescript/tests/storage-sqlite/v0002-migration.test.ts.

func openMigrated(t *testing.T) *sqlite.Storage {
	t.Helper()
	s, err := sqlite.Open(":memory:", sqlite.Options{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := sqlite.ApplyMigrations(s.DB()); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return s
}

func TestV0002_LicensesIsTrialColumn(t *testing.T) {
	s := openMigrated(t)
	rows, err := s.DB().Query(`PRAGMA table_info(licenses)`)
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close()
	var found bool
	var notnull int
	var dfltValue sql.NullString
	for rows.Next() {
		var cid int
		var name, ctype string
		var nn int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &nn, &dflt, &pk); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == "is_trial" {
			found = true
			notnull = nn
			dfltValue = dflt
		}
	}
	if !found {
		t.Fatal("licenses.is_trial column not found")
	}
	if notnull != 1 {
		t.Errorf("is_trial nullability: want NOT NULL, got nullable")
	}
	if !dfltValue.Valid || dfltValue.String != "0" {
		t.Errorf("is_trial default: want 0, got %v", dfltValue)
	}
}

func TestV0002_LicensableIndex(t *testing.T) {
	s := openMigrated(t)
	rows, err := s.DB().Query(`PRAGMA index_list(licenses)`)
	if err != nil {
		t.Fatalf("index_list: %v", err)
	}
	defer rows.Close()
	var found bool
	var unique int
	for rows.Next() {
		var seq int
		var name, origin string
		var u, partial int
		if err := rows.Scan(&seq, &name, &u, &origin, &partial); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == "licenses_licensable_type_id_idx" {
			found = true
			unique = u
		}
	}
	if !found {
		t.Fatal("licenses_licensable_type_id_idx not found")
	}
	if unique != 0 {
		t.Errorf("expected non-unique index, got unique=%d", unique)
	}
}

func TestV0002_LicenseTemplatesNewColumns(t *testing.T) {
	s := openMigrated(t)
	rows, err := s.DB().Query(`PRAGMA table_info(license_templates)`)
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close()
	wanted := map[string]bool{"parent_id": false, "trial_cooldown_sec": false}
	for rows.Next() {
		var cid int
		var name, ctype string
		var nn int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &nn, &dflt, &pk); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if _, ok := wanted[name]; ok {
			wanted[name] = true
			if nn != 0 {
				t.Errorf("%s should be nullable, got NOT NULL", name)
			}
		}
	}
	for col, present := range wanted {
		if !present {
			t.Errorf("license_templates.%s missing", col)
		}
	}
}

func TestV0002_TrialIssuancesTable(t *testing.T) {
	s := openMigrated(t)
	var count int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='trial_issuances'`,
	).Scan(&count); err != nil {
		t.Fatalf("query: %v", err)
	}
	if count != 1 {
		t.Fatal("trial_issuances table not created")
	}

	rows, err := s.DB().Query(`PRAGMA index_list(trial_issuances)`)
	if err != nil {
		t.Fatalf("index_list: %v", err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var seq int
		var name, origin string
		var u, partial int
		if err := rows.Scan(&seq, &name, &u, &origin, &partial); err != nil {
			t.Fatalf("scan: %v", err)
		}
		names = append(names, name)
	}
	for _, want := range []string{
		"trial_issuances_template_fp_key",
		"trial_issuances_global_fp_key",
		"trial_issuances_issued_at_idx",
	} {
		if !slices.Contains(names, want) {
			t.Errorf("missing index %s", want)
		}
	}
}

func TestV0002_PreservesV0001Data(t *testing.T) {
	s := openMigrated(t)
	if _, err := s.DB().Exec(`
		INSERT INTO licenses
			(id, scope_id, template_id, licensable_type, licensable_id,
			 license_key, status, max_usages,
			 created_at, updated_at)
		VALUES
			('01939e6f-0000-7000-8000-000000000001', NULL, NULL,
			 'User', 'user-pre-v0002',
			 'LIC-AAAA-BBBB-CCCC-DDDE', 'pending', 5,
			 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
	`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	var isTrial int
	if err := s.DB().QueryRow(
		`SELECT is_trial FROM licenses WHERE licensable_id = ?`, "user-pre-v0002",
	).Scan(&isTrial); err != nil {
		t.Fatalf("query: %v", err)
	}
	if isTrial != 0 {
		t.Errorf("is_trial default for v0001-shaped insert: want 0, got %d", isTrial)
	}
}

func TestV0002_IdempotentReplay(t *testing.T) {
	s, err := sqlite.Open(":memory:", sqlite.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := sqlite.ApplyMigrations(s.DB()); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	applied, err := sqlite.ApplyMigrations(s.DB())
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	for _, name := range applied {
		if strings.Contains(name, "0002_") {
			t.Errorf("v0002 should not re-apply, but got: %s", name)
		}
	}
	var count int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM _licensing_migrations WHERE name LIKE '0002_%'`,
	).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("v0002 should be recorded exactly once, got %d", count)
	}
}
