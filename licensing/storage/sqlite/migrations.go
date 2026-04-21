package sqlite

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type migration struct {
	name string
	sql  string
}

func loadMigrations() ([]migration, error) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	var migs []migration
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", e.Name(), err)
		}
		migs = append(migs, migration{name: e.Name(), sql: string(data)})
	}
	sort.Slice(migs, func(i, j int) bool { return migs[i].name < migs[j].name })
	return migs, nil
}

// ApplyMigrations runs all pending migrations in lexicographic order.
// Each migration is wrapped in a transaction so partial apply never
// leaves the schema wedged. Returns the names of migrations applied
// this call (empty = nothing to do).
func ApplyMigrations(db *sql.DB) ([]string, error) {
	migs, err := loadMigrations()
	if err != nil {
		return nil, err
	}

	// Ensure the tracking table exists.
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS _licensing_migrations (
			name       TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)
	`); err != nil {
		return nil, fmt.Errorf("ensure migrations table: %w", err)
	}

	var applied []string
	for _, mig := range migs {
		var exists bool
		err := db.QueryRow(
			"SELECT EXISTS(SELECT 1 FROM _licensing_migrations WHERE name = ?)",
			mig.name,
		).Scan(&exists)
		if err != nil {
			return applied, fmt.Errorf("check migration %s: %w", mig.name, err)
		}
		if exists {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return applied, fmt.Errorf("begin tx for %s: %w", mig.name, err)
		}
		if _, err := tx.Exec(mig.sql); err != nil {
			_ = tx.Rollback()
			return applied, fmt.Errorf("apply %s: %w", mig.name, err)
		}
		if _, err := tx.Exec("INSERT INTO _licensing_migrations (name) VALUES (?)", mig.name); err != nil {
			_ = tx.Rollback()
			return applied, fmt.Errorf("record %s: %w", mig.name, err)
		}
		if err := tx.Commit(); err != nil {
			return applied, fmt.Errorf("commit %s: %w", mig.name, err)
		}
		applied = append(applied, mig.name)
	}
	return applied, nil
}

// ListMigrations returns the names of all embedded migration files in
// lexicographic order.
func ListMigrations() ([]string, error) {
	migs, err := loadMigrations()
	if err != nil {
		return nil, err
	}
	names := make([]string, len(migs))
	for i, m := range migs {
		names[i] = m.name
	}
	return names, nil
}
