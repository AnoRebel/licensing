package postgres_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/storage/postgres"
)

// Postgres-backed JtiLedger conformance tests. Mirror the in-memory
// reference suite in licensing/client/jti_ledger_test.go and the SQLite
// adapter suite so every implementation is held to the same contract.
//
// Gated on LICENSING_PG_URL (same env var as the main Postgres
// conformance suite). Skipped when unset, so CI without a Postgres
// container is unaffected.
//
// Local bootstrap:
//
//	docker run --rm -d -p 55432:5432 \
//	  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=licensing_test \
//	  --name licensing-pg postgres:18-alpine
//	export LICENSING_PG_URL="postgres://postgres:test@localhost:55432/licensing_test?sslmode=disable"

func newPgJtiLedger(t *testing.T) *postgres.JtiLedger {
	t.Helper()
	dsn := os.Getenv("LICENSING_PG_URL")
	if dsn == "" {
		t.Skip("LICENSING_PG_URL not set — skipping Postgres JtiLedger tests")
	}

	ctx := context.Background()
	masterPool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("master pool: %v", err)
	}
	t.Cleanup(masterPool.Close)

	// Per-test schema for isolation — matches the main conformance suite.
	schema := randomJtiSchema()
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
	cfg.MaxConns = 6
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pgxpool.NewWithConfig: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := postgres.ApplyMigrations(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return postgres.NewJtiLedger(pool)
}

func randomJtiSchema() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "jti_" + hex.EncodeToString(b)
}

func TestPostgresJtiLedger_FirstUseRecorded(t *testing.T) {
	l := newPgJtiLedger(t)
	first, err := l.RecordJtiUse("jti-a", 2_000_000_100)
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("first call must report firstUse=true")
	}
}

func TestPostgresJtiLedger_SecondUseRejected(t *testing.T) {
	l := newPgJtiLedger(t)
	if _, err := l.RecordJtiUse("jti-a", 2_000_000_100); err != nil {
		t.Fatal(err)
	}
	first, err := l.RecordJtiUse("jti-a", 2_000_000_100)
	if err != nil {
		t.Fatal(err)
	}
	if first {
		t.Fatal("second call must report firstUse=false")
	}
}

func TestPostgresJtiLedger_DistinctJtisCoexist(t *testing.T) {
	l := newPgJtiLedger(t)
	for _, jti := range []string{"a", "b", "c"} {
		first, err := l.RecordJtiUse(jti, 2_000_000_100)
		if err != nil {
			t.Fatalf("jti %s: %v", jti, err)
		}
		if !first {
			t.Fatalf("jti %s: want first=true", jti)
		}
	}
}

func TestPostgresJtiLedger_PruneExpired(t *testing.T) {
	l := newPgJtiLedger(t)
	_, _ = l.RecordJtiUse("expired-1", 100)
	_, _ = l.RecordJtiUse("expired-2", 200)
	_, _ = l.RecordJtiUse("alive", 9_000_000_000)

	removed, err := l.PruneExpired(500)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed: want 2, got %d", removed)
	}

	// Idempotent.
	removed, err = l.PruneExpired(500)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("idempotent prune: want 0, got %d", removed)
	}

	// Pruned jti can be re-recorded.
	first, err := l.RecordJtiUse("expired-1", 9_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("after prune, the jti can be recorded again as first-use")
	}
}

func TestPostgresJtiLedger_PruneBoundaryIsInclusive(t *testing.T) {
	l := newPgJtiLedger(t)
	_, _ = l.RecordJtiUse("exact", 1_000)
	removed, _ := l.PruneExpired(1_000)
	if removed != 1 {
		t.Fatalf("boundary inclusive: want 1 removed, got %d", removed)
	}
}

func TestPostgresJtiLedger_ConcurrentRecordsAreSafe(t *testing.T) {
	// Postgres serializes via the unique constraint; verify that a
	// contended jti record produces exactly one firstUse=true result.
	l := newPgJtiLedger(t)
	var wg sync.WaitGroup
	var firstCount int64
	var mu sync.Mutex
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			first, err := l.RecordJtiUse("contended", 2_000_000_100)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if first {
				mu.Lock()
				firstCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if firstCount != 1 {
		t.Fatalf("exactly one goroutine must win: got %d firstUse=true", firstCount)
	}
}

// Compile-time interface check.
var _ client.JtiLedger = (*postgres.JtiLedger)(nil)
