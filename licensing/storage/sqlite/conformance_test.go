package sqlite_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/conformance"
	"github.com/AnoRebel/licensing/licensing/storage/sqlite"
)

func TestConformance(t *testing.T) {
	conformance.RunAll(t, func(t *testing.T) lic.Storage {
		s, err := sqlite.Open(":memory:", sqlite.Options{})
		if err != nil {
			t.Fatalf("open sqlite: %v", err)
		}
		t.Cleanup(func() { s.Close() })

		if _, err := sqlite.ApplyMigrations(s.DB()); err != nil {
			t.Fatalf("apply migrations: %v", err)
		}
		return s
	})
}
