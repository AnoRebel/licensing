package memory

// Memory-adapter-specific tests. The shared Storage conformance suite
// (licensing/storage/conformance, task #61) exercises the interface
// contract across every adapter; the tests here cover concerns that
// are memory-specific:
//
//   - transaction rollback leaves no observable mutation
//   - nested transactions are rejected
//   - DescribeSchema matches the canonical schema
//   - concurrent access is safe (mutex coverage)

import (
	"errors"
	"sync"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

func newStorage(t *testing.T) *Storage {
	t.Helper()
	return New(Options{})
}

// ---------- Transactions ----------

func TestWithTransaction_CommitsOnNilReturn(t *testing.T) {
	s := newStorage(t)
	var createdID string
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		row, err := tx.CreateScope(lic.LicenseScopeInput{Slug: "acme", Name: "Acme"})
		if err != nil {
			return err
		}
		createdID = row.ID
		return nil
	}); err != nil {
		t.Fatalf("tx: %v", err)
	}
	got, err := s.GetScope(createdID)
	if err != nil {
		t.Fatalf("GetScope: %v", err)
	}
	if got == nil || got.Slug != "acme" {
		t.Fatalf("scope not committed: %+v", got)
	}
}

func TestWithTransaction_RollsBackOnError(t *testing.T) {
	s := newStorage(t)
	sentinel := errors.New("rollback me")
	err := s.WithTransaction(func(tx lic.StorageTx) error {
		if _, err := tx.CreateScope(lic.LicenseScopeInput{Slug: "acme", Name: "Acme"}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel, got %v", err)
	}
	// Scope must NOT be visible post-rollback.
	got, err := s.GetScopeBySlug("acme")
	if err != nil {
		t.Fatalf("GetScopeBySlug: %v", err)
	}
	if got != nil {
		t.Fatalf("scope leaked out of rolled-back tx: %+v", got)
	}
}

func TestWithTransaction_NestedIsRejected(t *testing.T) {
	// Nested transactions are prevented at compile time, not runtime: the
	// *memoryTx handle passed to fn implements lic.StorageTx but NOT
	// lic.Storage, so tx.WithTransaction doesn't exist on the handle. A
	// runtime re-entry of Storage.WithTransaction from inside fn would
	// deadlock the caller's goroutine on the mutex it already holds, so
	// the only correct design is to remove WithTransaction from the tx
	// surface entirely — which is what StorageTx does.
	//
	// The assertion below is the guarantee: if someone widened the tx
	// surface to include WithTransaction, this would stop compiling.
	var _ lic.StorageTx = (*memoryTx)(nil)
	// Narrow guard: memoryTx must NOT be assignable to Storage (which
	// would mean it carries WithTransaction). We can't express
	// "absence of a method" directly, so we just confirm the public
	// narrower interface is the one fn receives.
	s := newStorage(t)
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		if _, ok := tx.(lic.Storage); ok {
			t.Fatal("tx handle must not satisfy lic.Storage (would allow nesting)")
		}
		return nil
	}); err != nil {
		t.Fatalf("tx: %v", err)
	}
}

func TestWithTransaction_RollbackPreservesPreExistingState(t *testing.T) {
	s := newStorage(t)
	// Seed a row outside any tx.
	if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: "keeper", Name: "Keeper"}); err != nil {
		t.Fatal(err)
	}
	// Start a tx that mutates and then aborts.
	_ = s.WithTransaction(func(tx lic.StorageTx) error {
		name := "Renamed"
		keeper, _ := tx.GetScopeBySlug("keeper")
		if _, err := tx.UpdateScope(keeper.ID, lic.LicenseScopePatch{Name: &name}); err != nil {
			return err
		}
		return errors.New("abort")
	})
	// The pre-existing row must still carry its original name.
	got, _ := s.GetScopeBySlug("keeper")
	if got == nil || got.Name != "Keeper" {
		t.Fatalf("pre-existing state not preserved: %+v", got)
	}
}

// ---------- Schema parity ----------

func TestDescribeSchema_MatchesCanonical(t *testing.T) {
	s := newStorage(t)
	got := s.DescribeSchema()
	want := lic.CanonicalSchema()
	if len(got) != len(want) {
		t.Fatalf("entity count: got=%d want=%d", len(got), len(want))
	}
	for i, ent := range want {
		if got[i].Name != ent.Name {
			t.Fatalf("entity %d: got=%s want=%s", i, got[i].Name, ent.Name)
		}
		if len(got[i].Columns) != len(ent.Columns) {
			t.Fatalf("entity %s column count: got=%d want=%d", ent.Name, len(got[i].Columns), len(ent.Columns))
		}
	}
}

// ---------- Concurrency ----------

func TestConcurrentCreates_AllSucceed(t *testing.T) {
	// Stress the mutex: many goroutines racing on Create. The adapter
	// must not corrupt its map, and every successful Create must be
	// observable afterwards.
	s := newStorage(t)
	const n = 50
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.CreateScope(lic.LicenseScopeInput{
				Slug: slugOf(i),
				Name: "scope-" + slugOf(i),
			})
			if err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent create: %v", err)
	}
	page, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 500})
	if err != nil {
		t.Fatalf("ListScopes: %v", err)
	}
	if len(page.Items) != n {
		t.Fatalf("expected %d rows, got %d", n, len(page.Items))
	}
}

// ---------- Uniqueness sanity ----------

func TestCreateLicense_EnforcesLicenseKeyUniqueness(t *testing.T) {
	s := newStorage(t)
	in := lic.LicenseInput{
		LicensableType: "User",
		LicensableID:   "u1",
		LicenseKey:     "XYZ",
		Status:         lic.LicenseStatusActive,
		MaxUsages:      1,
	}
	if _, err := s.CreateLicense(in); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := s.CreateLicense(in)
	if err == nil {
		t.Fatal("expected conflict on duplicate license_key")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseKeyConflict {
		t.Fatalf("expected LicenseKeyConflict, got %v", err)
	}
}

func TestCreateUsage_ActivePairUnique(t *testing.T) {
	s := newStorage(t)
	lic1, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1", LicenseKey: "L1",
		Status: lic.LicenseStatusActive, MaxUsages: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	in := lic.LicenseUsageInput{
		LicenseID: lic1.ID, Fingerprint: "fp1",
		Status: lic.UsageStatusActive, RegisteredAt: "2026-01-01T00:00:00Z",
	}
	if _, err := s.CreateUsage(in); err != nil {
		t.Fatalf("first active: %v", err)
	}
	if _, err := s.CreateUsage(in); err == nil {
		t.Fatal("expected active-pair conflict")
	}
	// A revoked duplicate IS allowed — the partial index is WHERE status='active'.
	revoked := in
	revoked.Status = lic.UsageStatusRevoked
	if _, err := s.CreateUsage(revoked); err != nil {
		t.Fatalf("revoked duplicate should be allowed: %v", err)
	}
}

func TestCreateKey_ActiveSigningSingleton(t *testing.T) {
	s := newStorage(t)
	in := lic.LicenseKeyInput{
		Kid: "k1", Alg: lic.AlgEd25519, Role: lic.RoleSigning, State: lic.StateActive,
		PublicPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
		NotBefore: "2026-01-01T00:00:00Z",
	}
	if _, err := s.CreateKey(in); err != nil {
		t.Fatal(err)
	}
	in2 := in
	in2.Kid = "k2"
	if _, err := s.CreateKey(in2); err == nil {
		t.Fatal("expected scope_active_signing conflict")
	}
	// A retiring signing key is allowed alongside an active one.
	in3 := in
	in3.Kid = "k3"
	in3.State = lic.StateRetiring
	if _, err := s.CreateKey(in3); err != nil {
		t.Fatalf("retiring duplicate should be allowed: %v", err)
	}
}

// ---------- Pagination / cursor ----------

func TestListScopes_CursorPaginatesCorrectly(t *testing.T) {
	s := newStorage(t)
	// Seed 5 scopes — the DESC ordering means the most recent one is
	// emitted first.
	for i := range 5 {
		if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: slugOf(i), Name: "n"}); err != nil {
			t.Fatal(err)
		}
	}
	// First page of 2.
	p1, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(p1.Items) != 2 {
		t.Fatalf("page 1 size: %d", len(p1.Items))
	}
	if p1.Cursor == "" {
		t.Fatal("page 1 missing continuation cursor")
	}
	// Second page of 2.
	p2, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 2, Cursor: p1.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Items) != 2 {
		t.Fatalf("page 2 size: %d", len(p2.Items))
	}
	// Third page: 1 item, no cursor (end of set).
	p3, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 2, Cursor: p2.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(p3.Items) != 1 {
		t.Fatalf("page 3 size: %d", len(p3.Items))
	}
	if p3.Cursor != "" {
		t.Fatalf("page 3 should be terminal, got cursor %q", p3.Cursor)
	}
	// Malformed cursor → treated as first page (graceful degradation).
	pMal, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 10, Cursor: "not-valid-base64!"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pMal.Items) != 5 {
		t.Fatalf("malformed-cursor page should return all 5, got %d", len(pMal.Items))
	}
}

// ---------- AuditLog immutability ----------

func TestAuditLog_NoUpdatePath(t *testing.T) {
	// The adapter doesn't expose UpdateAudit / DeleteAudit — compile-time
	// only `AppendAudit`, `GetAudit`, `ListAudit` exist on the interface.
	// This test verifies append + list ordering using OccurredAt instead
	// of CreatedAt (AuditLog has no CreatedAt column).
	s := newStorage(t)
	for i, ev := range []string{"a", "b", "c"} {
		if _, err := s.AppendAudit(lic.AuditLogInput{
			Actor: "system", Event: ev,
			OccurredAt: "2026-01-0" + string(rune('1'+i)) + "T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.ListAudit(lic.AuditLogFilter{}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 3 {
		t.Fatalf("expected 3 audit rows, got %d", len(p.Items))
	}
	// DESC by OccurredAt: "c" first, "a" last.
	if p.Items[0].Event != "c" || p.Items[2].Event != "a" {
		t.Fatalf("wrong audit order: %+v", p.Items)
	}
}

// ---------- helpers ----------

func slugOf(i int) string {
	// Produce a deterministic unique slug per index.
	const letters = "0123456789abcdefghijklmnopqrstuvwxyz"
	if i < len(letters) {
		return "s-" + string(letters[i])
	}
	return "s-" + string(letters[i%len(letters)]) + string(letters[(i/len(letters))%len(letters)])
}
