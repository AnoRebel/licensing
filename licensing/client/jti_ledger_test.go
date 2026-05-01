package client

import (
	"errors"
	"sync"
	"testing"
)

// In-memory ledger contract tests. These also serve as the reference
// behavioural spec that the SQLite + Postgres adapters' conformance
// tests check against.

func TestMemoryJtiLedger_FirstUseRecorded(t *testing.T) {
	l := NewMemoryJtiLedger()
	first, err := l.RecordJtiUse("jti-a", 2_000_000_100)
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("first call must report firstUse=true")
	}
	if l.Size() != 1 {
		t.Fatalf("ledger size: want 1, got %d", l.Size())
	}
}

func TestMemoryJtiLedger_SecondUseRejected(t *testing.T) {
	l := NewMemoryJtiLedger()
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

func TestMemoryJtiLedger_DistinctJtisCoexist(t *testing.T) {
	l := NewMemoryJtiLedger()
	for _, jti := range []string{"a", "b", "c"} {
		first, err := l.RecordJtiUse(jti, 2_000_000_100)
		if err != nil {
			t.Fatal(err)
		}
		if !first {
			t.Fatalf("jti %s: want first=true", jti)
		}
	}
	if l.Size() != 3 {
		t.Fatalf("ledger size: want 3, got %d", l.Size())
	}
}

func TestMemoryJtiLedger_PruneExpired(t *testing.T) {
	l := NewMemoryJtiLedger()
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
	if l.Size() != 1 {
		t.Fatalf("size after prune: want 1, got %d", l.Size())
	}
	// Pruning is idempotent.
	removed, err = l.PruneExpired(500)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("idempotent prune: want 0 removed, got %d", removed)
	}
}

func TestMemoryJtiLedger_PruneBoundaryIsInclusive(t *testing.T) {
	// The contract says rows with expSec ≤ nowSec are removed. A row
	// expiring exactly at nowSec MUST be removed, not retained.
	l := NewMemoryJtiLedger()
	_, _ = l.RecordJtiUse("exact", 1_000)
	removed, _ := l.PruneExpired(1_000)
	if removed != 1 {
		t.Fatalf("boundary inclusive: want 1 removed, got %d", removed)
	}
}

func TestMemoryJtiLedger_ConcurrentRecordsAreSafe(t *testing.T) {
	// Drive 100 goroutines each trying to record the SAME jti. Exactly
	// one MUST report firstUse=true; the other 99 MUST report false.
	l := NewMemoryJtiLedger()
	var wg sync.WaitGroup
	var firstCount int64
	var mu sync.Mutex
	for i := 0; i < 100; i++ {
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
	if l.Size() != 1 {
		t.Fatalf("ledger size after contention: want 1, got %d", l.Size())
	}
}

// ---------- Validate integration ----------

func TestValidate_AcceptsFirstUseWithLedger(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	ledger := NewMemoryJtiLedger()
	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
		JtiLedger:   ledger,
	})
	if err != nil {
		t.Fatalf("first use must succeed: %v", err)
	}
	if res.LicenseID != "lic-1" {
		t.Fatalf("result drift: %+v", res)
	}
	if ledger.Size() != 1 {
		t.Fatalf("ledger should have recorded 1 entry, got %d", ledger.Size())
	}
}

func TestValidate_RejectsReplayWithLedger(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	ledger := NewMemoryJtiLedger()
	opts := ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
		JtiLedger:   ledger,
	}
	if _, err := Validate(tok, opts); err != nil {
		t.Fatalf("first use must succeed: %v", err)
	}
	_, err := Validate(tok, opts)
	if !errors.Is(err, ErrTokenReplayed) {
		t.Fatalf("second use must surface ErrTokenReplayed, got %v", err)
	}
}

func TestValidate_DoesNotBurnLedgerEntryOnUpstreamFailure(t *testing.T) {
	// A token that fails an earlier check (here: fingerprint mismatch)
	// MUST NOT consume a ledger entry — otherwise the caller can lock
	// out a legitimate later validate by sending a malformed earlier
	// one.
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	ledger := NewMemoryJtiLedger()
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "WRONG-FP",
		NowSec:      now,
		JtiLedger:   ledger,
	})
	if !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("want ErrFingerprintMismatch, got %v", err)
	}
	if ledger.Size() != 0 {
		t.Fatalf("ledger must remain empty on upstream failure: %d", ledger.Size())
	}

	// And then the legitimate validate (correct fingerprint) succeeds.
	_, err = Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
		JtiLedger:   ledger,
	})
	if err != nil {
		t.Fatalf("legit validate after failed validate must succeed: %v", err)
	}
}

func TestValidate_NilLedgerIsNoop(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	opts := ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
		// JtiLedger: nil — replay protection disabled
	}
	// Same token validated twice must succeed both times — no ledger
	// means the offline-first use case is unaffected.
	if _, err := Validate(tok, opts); err != nil {
		t.Fatalf("first validate: %v", err)
	}
	if _, err := Validate(tok, opts); err != nil {
		t.Fatalf("second validate must succeed without ledger: %v", err)
	}
}
