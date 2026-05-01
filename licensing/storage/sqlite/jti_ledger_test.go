package sqlite_test

import (
	"database/sql"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/storage/sqlite"
)

// SQLite-backed JtiLedger conformance tests. Mirrors the in-memory
// reference suite in licensing/client/jti_ledger_test.go so every
// implementation is held to the same contract.

func newJtiDB(t *testing.T) *sql.DB {
	t.Helper()
	// Match the DSN used by sqlite.Open so the test exercises the same
	// concurrency posture (WAL + immediate txlock + busy timeout) that
	// production deployments get. Without busy_timeout SQLite returns
	// SQLITE_BUSY on contention rather than queueing.
	dsn := "file://" + filepath.Join(t.TempDir(), "jti.sqlite") +
		"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := sqlite.ApplyMigrations(db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return db
}

func TestSqliteJtiLedger_FirstUseRecorded(t *testing.T) {
	l := sqlite.NewJtiLedger(newJtiDB(t))
	first, err := l.RecordJtiUse("jti-a", 2_000_000_100)
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("first call must report firstUse=true")
	}
}

func TestSqliteJtiLedger_SecondUseRejected(t *testing.T) {
	l := sqlite.NewJtiLedger(newJtiDB(t))
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

func TestSqliteJtiLedger_DistinctJtisCoexist(t *testing.T) {
	l := sqlite.NewJtiLedger(newJtiDB(t))
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

func TestSqliteJtiLedger_PruneExpired(t *testing.T) {
	l := sqlite.NewJtiLedger(newJtiDB(t))
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

func TestSqliteJtiLedger_PruneBoundaryIsInclusive(t *testing.T) {
	l := sqlite.NewJtiLedger(newJtiDB(t))
	_, _ = l.RecordJtiUse("exact", 1_000)
	removed, _ := l.PruneExpired(1_000)
	if removed != 1 {
		t.Fatalf("boundary inclusive: want 1 removed, got %d", removed)
	}
}

func TestSqliteJtiLedger_ConcurrentRecordsAreSafe(t *testing.T) {
	// SQLite serializes writers; verify that a contended jti record
	// produces exactly one firstUse=true result.
	l := sqlite.NewJtiLedger(newJtiDB(t))
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

// Compile-time interface check verifies the adapter satisfies the
// client.JtiLedger interface — also catches signature drift.
var _ client.JtiLedger = (*sqlite.JtiLedger)(nil)
