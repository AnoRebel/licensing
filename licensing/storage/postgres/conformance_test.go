package postgres_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/conformance"
	"github.com/AnoRebel/licensing/licensing/storage/postgres"
)

// Set LICENSING_PG_URL to run Postgres conformance tests.
// Same env var as the TypeScript tests. Example:
//
//	docker run --rm -d -p 55432:5432 \
//	  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=licensing_test \
//	  --name licensing-pg postgres:18-alpine
//
//	LICENSING_PG_URL="postgres://postgres:test@localhost:55432/licensing_test?sslmode=disable" \
//	  go test -race -v ./licensing/storage/postgres/
func TestConformance(t *testing.T) {
	dsn := os.Getenv("LICENSING_PG_URL")
	if dsn == "" {
		t.Skip("LICENSING_PG_URL not set — skipping Postgres conformance tests")
	}

	// Master pool for schema management (no search_path override).
	masterPool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("master pool: %v", err)
	}
	t.Cleanup(masterPool.Close)

	conformance.RunAll(t, func(t *testing.T) lic.Storage {
		ctx := context.Background()

		// Each subtest gets its own random schema for full isolation.
		schema := randomSchema()
		if _, err := masterPool.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %q`, schema)); err != nil {
			t.Fatalf("create schema: %v", err)
		}
		t.Cleanup(func() {
			_, _ = masterPool.Exec(ctx, fmt.Sprintf(`DROP SCHEMA %q CASCADE`, schema))
		})

		// Build a pool whose connections set search_path to our schema.
		cfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			t.Fatalf("parse config: %v", err)
		}
		cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			_, err := conn.Exec(ctx, fmt.Sprintf(`SET search_path TO %q, public`, schema))
			return err
		}
		cfg.MaxConns = 6

		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatalf("pgxpool.NewWithConfig: %v", err)
		}
		t.Cleanup(pool.Close)

		if _, err := postgres.ApplyMigrations(ctx, pool); err != nil {
			t.Fatalf("apply migrations: %v", err)
		}
		return postgres.New(pool, postgres.Options{})
	})
}

// randomSchema returns a unique schema name like "t_a1b2c3d4".
func randomSchema() string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return "t_" + hex.EncodeToString(buf[:])
}
