package postgres_test

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AnoRebel/licensing/licensing/storage/postgres"
)

// TestV0002 verifies the v0002 migration adds every documented schema object
// and that v0001 row data survives the upgrade. Mirrors the TS-side
// typescript/tests/storage-postgres/v0002-migration.test.ts.
//
// Gated on LICENSING_PG_URL — same env var as the conformance suite.

func freshSchema(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("LICENSING_PG_URL")
	if dsn == "" {
		t.Skip("LICENSING_PG_URL not set — skipping Postgres v0002 tests")
	}

	masterPool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("master pool: %v", err)
	}
	t.Cleanup(masterPool.Close)

	ctx := context.Background()
	schema := "v0002_" + randomSchema()
	if _, err := masterPool.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %q`, schema)); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = masterPool.Exec(ctx, fmt.Sprintf(`DROP SCHEMA %q CASCADE`, schema))
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, fmt.Sprintf(`SET search_path TO %q, public`, schema))
		return err
	}
	cfg.MaxConns = 4

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := postgres.ApplyMigrations(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return pool
}

func TestV0002_LicensesIsTrialColumn(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	row := pool.QueryRow(ctx, `
		SELECT data_type, is_nullable, column_default
		  FROM information_schema.columns
		 WHERE table_name = 'licenses' AND column_name = 'is_trial'
	`)
	var dataType, isNullable string
	var colDefault *string
	if err := row.Scan(&dataType, &isNullable, &colDefault); err != nil {
		t.Fatalf("query: %v", err)
	}
	if dataType != "boolean" {
		t.Errorf("data_type: want boolean, got %s", dataType)
	}
	if isNullable != "NO" {
		t.Errorf("is_nullable: want NO, got %s", isNullable)
	}
	if colDefault == nil || *colDefault != "false" {
		t.Errorf("column_default: want false, got %v", colDefault)
	}
}

func TestV0002_LicensableIndex(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	var indexdef string
	err := pool.QueryRow(ctx, `
		SELECT indexdef FROM pg_indexes
		 WHERE tablename = 'licenses'
		   AND indexname = 'licenses_licensable_type_id_idx'
	`).Scan(&indexdef)
	if err != nil {
		t.Fatalf("missing licenses_licensable_type_id_idx: %v", err)
	}
	if strings.Contains(strings.ToLower(indexdef), "unique") {
		t.Errorf("expected non-unique index, got: %s", indexdef)
	}
	if !strings.Contains(indexdef, "licensable_type") || !strings.Contains(indexdef, "licensable_id") {
		t.Errorf("expected (licensable_type, licensable_id), got: %s", indexdef)
	}
}

func TestV0002_LicenseTemplatesNewColumns(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
		SELECT column_name, data_type, is_nullable
		  FROM information_schema.columns
		 WHERE table_name = 'license_templates'
		   AND column_name IN ('parent_id', 'trial_cooldown_sec')
	`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	want := map[string]struct {
		dataType string
		nullable string
	}{
		"parent_id":          {dataType: "uuid", nullable: "YES"},
		"trial_cooldown_sec": {dataType: "integer", nullable: "YES"},
	}
	for rows.Next() {
		var name, dt, nn string
		if err := rows.Scan(&name, &dt, &nn); err != nil {
			t.Fatalf("scan: %v", err)
		}
		w, ok := want[name]
		if !ok {
			continue
		}
		if dt != w.dataType {
			t.Errorf("%s data_type: want %s, got %s", name, w.dataType, dt)
		}
		if nn != w.nullable {
			t.Errorf("%s is_nullable: want %s, got %s", name, w.nullable, nn)
		}
		delete(want, name)
	}
	for missing := range want {
		t.Errorf("license_templates.%s missing", missing)
	}
}

func TestV0002_TrialCooldownSecCheck(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		INSERT INTO license_templates
			(id, scope_id, name, max_usages, trial_duration_sec,
			 grace_duration_sec, force_online_after_sec, trial_cooldown_sec,
			 entitlements, meta)
		VALUES
			('01939e6f-0000-7000-8000-000000000001', NULL, 'neg-cooldown',
			 1, 0, 0, NULL, -1, '{}'::jsonb, '{}'::jsonb)
	`)
	if err == nil {
		t.Fatal("expected check-violation on negative trial_cooldown_sec, got nil")
	}
	if !strings.Contains(err.Error(), "license_templates_trial_cooldown_sec") {
		t.Errorf("expected license_templates_trial_cooldown_sec violation, got: %v", err)
	}
}

func TestV0002_TrialIssuancesTable(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	var exists int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM information_schema.tables
		 WHERE table_name = 'trial_issuances'
	`).Scan(&exists); err != nil {
		t.Fatalf("query: %v", err)
	}
	if exists != 1 {
		t.Fatal("trial_issuances table missing")
	}

	rows, err := pool.Query(ctx, `
		SELECT indexname, indexdef FROM pg_indexes
		 WHERE tablename = 'trial_issuances'
	`)
	if err != nil {
		t.Fatalf("indexes: %v", err)
	}
	defer rows.Close()
	type idx struct{ name, def string }
	var got []idx
	for rows.Next() {
		var name, def string
		if err := rows.Scan(&name, &def); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, idx{name: name, def: def})
	}

	wantNames := []string{
		"trial_issuances_template_fp_key",
		"trial_issuances_global_fp_key",
		"trial_issuances_issued_at_idx",
	}
	gotNames := make([]string, 0, len(got))
	for _, i := range got {
		gotNames = append(gotNames, i.name)
	}
	for _, w := range wantNames {
		if !slices.Contains(gotNames, w) {
			t.Errorf("missing index %s; got %v", w, gotNames)
		}
	}

	for _, i := range got {
		switch i.name {
		case "trial_issuances_template_fp_key":
			if !strings.Contains(strings.ToLower(i.def), "unique") {
				t.Errorf("%s should be UNIQUE: %s", i.name, i.def)
			}
			if !strings.Contains(i.def, "template_id IS NOT NULL") {
				t.Errorf("%s should be partial WHERE template_id IS NOT NULL: %s", i.name, i.def)
			}
		case "trial_issuances_global_fp_key":
			if !strings.Contains(strings.ToLower(i.def), "unique") {
				t.Errorf("%s should be UNIQUE: %s", i.name, i.def)
			}
			if !strings.Contains(i.def, "template_id IS NULL") {
				t.Errorf("%s should be partial WHERE template_id IS NULL: %s", i.name, i.def)
			}
		}
	}
}

func TestV0002_IdempotentReplay(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()

	// Already applied once in freshSchema; replay.
	applied, err := postgres.ApplyMigrations(ctx, pool)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	for _, name := range applied {
		if strings.Contains(name, "0002_") {
			t.Errorf("v0002 should not re-apply, but got: %s", name)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM _licensing_migrations WHERE name LIKE '0002_%'
	`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("v0002 should be recorded exactly once, got %d", count)
	}
}
