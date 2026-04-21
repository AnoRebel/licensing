// Package conformance provides shared test assertions that every
// Storage adapter must pass. Each adapter's own _test.go file calls
// RunAll(t, factory) where factory returns a fresh Storage instance.
//
// Tests cover: CRUD round-trips, uniqueness constraints, transactions,
// audit-log immutability, cursor pagination, and schema parity.
package conformance

import (
	"errors"
	"strings"
	"testing"
	"time"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// tsEqual compares two ISO timestamps, allowing for different precision
// (e.g. "2026-01-01T00:00:00Z" vs "2026-01-01T00:00:00.000000Z").
func tsEqual(a, b string) bool {
	if a == b {
		return true
	}
	// Try parsing both and comparing as time.Time.
	ta, ea := parseISO(a)
	tb, eb := parseISO(b)
	if ea != nil || eb != nil {
		return false
	}
	return ta.Equal(tb)
}

func parseISO(s string) (time.Time, error) {
	// Try common formats.
	for _, fmt := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000000Z",
	} {
		if t, err := time.Parse(fmt, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("cannot parse: " + s)
}

// Factory creates a fresh, empty Storage for a single test.
type Factory func(t *testing.T) lic.Storage

// RunAll runs the full conformance suite against the adapter produced
// by factory. Call this from each adapter's test file.
func RunAll(t *testing.T, factory Factory) {
	t.Helper()

	// --- CRUD ---
	t.Run("Scope_CRUD", func(t *testing.T) { testScopeCRUD(t, factory) })
	t.Run("License_CRUD", func(t *testing.T) { testLicenseCRUD(t, factory) })
	t.Run("Template_CRUD", func(t *testing.T) { testTemplateCRUD(t, factory) })
	t.Run("Usage_CRUD", func(t *testing.T) { testUsageCRUD(t, factory) })
	t.Run("Key_CRUD", func(t *testing.T) { testKeyCRUD(t, factory) })
	t.Run("Audit_AppendAndList", func(t *testing.T) { testAuditAppendAndList(t, factory) })

	// --- Uniqueness ---
	t.Run("License_KeyUnique", func(t *testing.T) { testLicenseKeyUnique(t, factory) })
	t.Run("Scope_SlugUnique", func(t *testing.T) { testScopeSlugUnique(t, factory) })
	t.Run("Usage_ActiveFPUnique", func(t *testing.T) { testUsageActiveFPUnique(t, factory) })
	t.Run("Key_ActiveSigningSingleton", func(t *testing.T) { testKeyActiveSigningSingleton(t, factory) })

	// --- Delete semantics ---
	t.Run("Delete_License", func(t *testing.T) { testDeleteLicense(t, factory) })
	t.Run("Delete_Scope", func(t *testing.T) { testDeleteScope(t, factory) })
	t.Run("Delete_Template", func(t *testing.T) { testDeleteTemplate(t, factory) })

	// --- Transactions ---
	t.Run("Tx_CommitOnNilReturn", func(t *testing.T) { testTxCommit(t, factory) })
	t.Run("Tx_RollbackOnError", func(t *testing.T) { testTxRollback(t, factory) })
	t.Run("Tx_RollbackPreservesState", func(t *testing.T) { testTxRollbackPreserves(t, factory) })

	// --- Pagination ---
	t.Run("Pagination_CursorCorrectness", func(t *testing.T) { testPaginationCursor(t, factory) })
	t.Run("Pagination_MalformedCursor", func(t *testing.T) { testPaginationMalformed(t, factory) })

	// --- Schema ---
	t.Run("Schema_MatchesCanonical", func(t *testing.T) { testSchemaCanonical(t, factory) })

	// --- Lifecycle state machine ---
	t.Run("Lifecycle_ActivatePending", func(t *testing.T) { testLifecycleActivate(t, factory) })
	t.Run("Lifecycle_SuspendResume", func(t *testing.T) { testLifecycleSuspendResume(t, factory) })
	t.Run("Lifecycle_Revoke", func(t *testing.T) { testLifecycleRevoke(t, factory) })
	t.Run("Lifecycle_EffectiveGrace", func(t *testing.T) { testLifecycleEffectiveGrace(t, factory) })
	t.Run("Lifecycle_TickPersistsGrace", func(t *testing.T) { testLifecycleTickGrace(t, factory) })
	t.Run("Lifecycle_RenewExpired", func(t *testing.T) { testLifecycleRenew(t, factory) })

	// --- Service layer ---
	t.Run("Service_CreateLicense", func(t *testing.T) { testServiceCreateLicense(t, factory) })
	t.Run("Service_FindLicenseByKey", func(t *testing.T) { testServiceFindByKey(t, factory) })
	t.Run("Service_RegisterUsage_SeatEnforcement", func(t *testing.T) { testServiceRegisterUsage(t, factory) })
	t.Run("Service_RegisterUsage_Idempotent", func(t *testing.T) { testServiceRegisterIdempotent(t, factory) })
	t.Run("Service_RegisterUsage_AutoActivation", func(t *testing.T) { testServiceAutoActivation(t, factory) })
	t.Run("Service_RevokeUsage", func(t *testing.T) { testServiceRevokeUsage(t, factory) })

	// --- Scope service ---
	t.Run("Service_CreateScope", func(t *testing.T) { testServiceCreateScope(t, factory) })
	t.Run("Service_CreateScope_DuplicateSlug", func(t *testing.T) { testServiceCreateScopeDupSlug(t, factory) })

	// --- Template service ---
	t.Run("Service_CreateTemplate", func(t *testing.T) { testServiceCreateTemplate(t, factory) })
	t.Run("Service_CreateTemplate_Validation", func(t *testing.T) { testServiceCreateTemplateValidation(t, factory) })
	t.Run("Service_CreateLicenseFromTemplate", func(t *testing.T) { testServiceCreateLicenseFromTemplate(t, factory) })
	t.Run("Service_CreateLicenseFromTemplate_Overrides", func(t *testing.T) { testServiceCreateLicenseFromTemplateOverrides(t, factory) })

	// --- Token issuer ---
	t.Run("Service_IssueToken", func(t *testing.T) { testServiceIssueToken(t, factory) })
}

// ---------- CRUD tests ----------

func testScopeCRUD(t *testing.T, factory Factory) {
	s := factory(t)
	created, err := s.CreateScope(lic.LicenseScopeInput{Slug: "acme", Name: "Acme Corp"})
	if err != nil {
		t.Fatalf("CreateScope: %v", err)
	}
	if created.Slug != "acme" || created.Name != "Acme Corp" {
		t.Fatalf("unexpected: %+v", created)
	}
	got, err := s.GetScope(created.ID)
	if err != nil {
		t.Fatalf("GetScope: %v", err)
	}
	if got == nil || got.ID != created.ID {
		t.Fatalf("round-trip failed: %+v", got)
	}
	bySlug, err := s.GetScopeBySlug("acme")
	if err != nil {
		t.Fatalf("GetScopeBySlug: %v", err)
	}
	if bySlug == nil || bySlug.ID != created.ID {
		t.Fatalf("slug lookup failed")
	}
	// Update
	newName := "Acme Inc"
	updated, err := s.UpdateScope(created.ID, lic.LicenseScopePatch{Name: &newName})
	if err != nil {
		t.Fatalf("UpdateScope: %v", err)
	}
	if updated.Name != "Acme Inc" || updated.ID != created.ID {
		t.Fatalf("update failed: %+v", updated)
	}
	if updated.CreatedAt != created.CreatedAt {
		t.Fatal("update must not change created_at")
	}
	// List
	page, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatalf("ListScopes: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 scope, got %d", len(page.Items))
	}
	// Miss
	miss, err := s.GetScope("00000000-0000-0000-0000-000000000000")
	if err != nil {
		t.Fatalf("GetScope miss: %v", err)
	}
	if miss != nil {
		t.Fatal("expected nil for missing scope")
	}
}

func testLicenseCRUD(t *testing.T, factory Factory) {
	s := factory(t)
	created, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: "LK-001", Status: lic.LicenseStatusActive,
		MaxUsages: 5,
	})
	if err != nil {
		t.Fatalf("CreateLicense: %v", err)
	}
	got, err := s.GetLicense(created.ID)
	if err != nil || got == nil || got.LicenseKey != "LK-001" {
		t.Fatalf("GetLicense: %v / %+v", err, got)
	}
	byKey, err := s.GetLicenseByKey("LK-001")
	if err != nil || byKey == nil || byKey.ID != created.ID {
		t.Fatalf("GetLicenseByKey: %v / %+v", err, byKey)
	}
	newMax := 10
	updated, err := s.UpdateLicense(created.ID, lic.LicensePatch{MaxUsages: &newMax})
	if err != nil {
		t.Fatalf("UpdateLicense: %v", err)
	}
	if updated.MaxUsages != 10 {
		t.Fatalf("update failed: max_usages=%d", updated.MaxUsages)
	}
	page, err := s.ListLicenses(lic.LicenseFilter{}, lic.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListLicenses: %v / %d items", err, len(page.Items))
	}
}

func testTemplateCRUD(t *testing.T, factory Factory) {
	s := factory(t)
	created, err := s.CreateTemplate(lic.LicenseTemplateInput{
		Name: "Standard", MaxUsages: 3,
		TrialDurationSec: 0, GraceDurationSec: 86400,
	})
	if err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}
	got, err := s.GetTemplate(created.ID)
	if err != nil || got == nil || got.Name != "Standard" {
		t.Fatalf("GetTemplate: %v / %+v", err, got)
	}
	page, err := s.ListTemplates(lic.LicenseTemplateFilter{}, lic.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListTemplates: %v / %d items", err, len(page.Items))
	}
}

func testUsageCRUD(t *testing.T, factory Factory) {
	s := factory(t)
	// Need a license first.
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: "LK-U", Status: lic.LicenseStatusActive,
		MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.CreateUsage(lic.LicenseUsageInput{
		LicenseID: l.ID, Fingerprint: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		Status: lic.UsageStatusActive, RegisteredAt: "2026-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("CreateUsage: %v", err)
	}
	got, err := s.GetUsage(created.ID)
	if err != nil || got == nil {
		t.Fatalf("GetUsage: %v / %+v", err, got)
	}
	page, err := s.ListUsages(lic.LicenseUsageFilter{}, lic.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListUsages: %v / %d items", err, len(page.Items))
	}
}

func testKeyCRUD(t *testing.T, factory Factory) {
	s := factory(t)
	created, err := s.CreateKey(lic.LicenseKeyInput{
		Kid: "k1", Alg: lic.AlgEd25519, Role: lic.RoleSigning, State: lic.StateActive,
		PublicPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
		NotBefore: "2026-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("CreateKey: %v", err)
	}
	got, err := s.GetKey(created.ID)
	if err != nil || got == nil || got.Kid != "k1" {
		t.Fatalf("GetKey: %v / %+v", err, got)
	}
	byKid, err := s.GetKeyByKid("k1")
	if err != nil || byKid == nil || byKid.ID != created.ID {
		t.Fatalf("GetKeyByKid: %v", err)
	}
	page, err := s.ListKeys(lic.LicenseKeyFilter{}, lic.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListKeys: %v / %d items", err, len(page.Items))
	}
}

func testAuditAppendAndList(t *testing.T, factory Factory) {
	s := factory(t)
	for i, ev := range []string{"a", "b", "c"} {
		if _, err := s.AppendAudit(lic.AuditLogInput{
			Actor: "system", Event: ev,
			OccurredAt: "2026-01-0" + string(rune('1'+i)) + "T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListAudit(lic.AuditLogFilter{}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("expected 3 audit rows, got %d", len(page.Items))
	}
	// DESC by occurred_at: "c" first, "a" last.
	if page.Items[0].Event != "c" || page.Items[2].Event != "a" {
		t.Fatalf("wrong audit order: [0]=%s [2]=%s", page.Items[0].Event, page.Items[2].Event)
	}
}

// ---------- Uniqueness tests ----------

func testLicenseKeyUnique(t *testing.T, factory Factory) {
	s := factory(t)
	in := lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: "DUPE", Status: lic.LicenseStatusActive, MaxUsages: 1,
	}
	if _, err := s.CreateLicense(in); err != nil {
		t.Fatal(err)
	}
	in.LicensableID = "u2" // different licensable, same key
	_, err := s.CreateLicense(in)
	if err == nil {
		t.Fatal("expected conflict on duplicate license_key")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseKeyConflict {
		t.Fatalf("expected LicenseKeyConflict, got %v", err)
	}
}

func testScopeSlugUnique(t *testing.T, factory Factory) {
	s := factory(t)
	if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: "dupe", Name: "A"}); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateScope(lic.LicenseScopeInput{Slug: "dupe", Name: "B"})
	if err == nil {
		t.Fatal("expected conflict on duplicate slug")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

func testUsageActiveFPUnique(t *testing.T, factory Factory) {
	s := factory(t)
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: "L1", Status: lic.LicenseStatusActive, MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	fp := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	in := lic.LicenseUsageInput{
		LicenseID: l.ID, Fingerprint: fp,
		Status: lic.UsageStatusActive, RegisteredAt: "2026-01-01T00:00:00Z",
	}
	if _, err := s.CreateUsage(in); err != nil {
		t.Fatalf("first active: %v", err)
	}
	if _, err := s.CreateUsage(in); err == nil {
		t.Fatal("expected active-pair conflict")
	}
	// Revoked duplicate is allowed.
	revoked := in
	revoked.Status = lic.UsageStatusRevoked
	if _, err := s.CreateUsage(revoked); err != nil {
		t.Fatalf("revoked duplicate should be allowed: %v", err)
	}
}

func testKeyActiveSigningSingleton(t *testing.T, factory Factory) {
	s := factory(t)
	in := lic.LicenseKeyInput{
		Kid: "k1", Alg: lic.AlgEd25519, Role: lic.RoleSigning, State: lic.StateActive,
		PublicPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
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
	// Retiring signing key is allowed alongside active.
	in3 := in
	in3.Kid = "k3"
	in3.State = lic.StateRetiring
	if _, err := s.CreateKey(in3); err != nil {
		t.Fatalf("retiring should be allowed: %v", err)
	}
}

// ---------- Transaction tests ----------

func testTxCommit(t *testing.T, factory Factory) {
	s := factory(t)
	var createdID string
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		row, err := tx.CreateScope(lic.LicenseScopeInput{Slug: "tx-ok", Name: "OK"})
		if err != nil {
			return err
		}
		createdID = row.ID
		return nil
	}); err != nil {
		t.Fatalf("tx: %v", err)
	}
	got, err := s.GetScope(createdID)
	if err != nil || got == nil || got.Slug != "tx-ok" {
		t.Fatalf("committed scope not visible: %+v / %v", got, err)
	}
}

func testTxRollback(t *testing.T, factory Factory) {
	s := factory(t)
	sentinel := errors.New("rollback me")
	err := s.WithTransaction(func(tx lic.StorageTx) error {
		if _, err := tx.CreateScope(lic.LicenseScopeInput{Slug: "tx-rb", Name: "RB"}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel, got %v", err)
	}
	got, err := s.GetScopeBySlug("tx-rb")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("scope leaked from rolled-back tx")
	}
}

func testTxRollbackPreserves(t *testing.T, factory Factory) {
	s := factory(t)
	if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: "keeper", Name: "Keeper"}); err != nil {
		t.Fatal(err)
	}
	_ = s.WithTransaction(func(tx lic.StorageTx) error {
		newName := "Renamed"
		keeper, _ := tx.GetScopeBySlug("keeper")
		if _, err := tx.UpdateScope(keeper.ID, lic.LicenseScopePatch{Name: &newName}); err != nil {
			return err
		}
		return errors.New("abort")
	})
	got, _ := s.GetScopeBySlug("keeper")
	if got == nil || got.Name != "Keeper" {
		t.Fatalf("pre-existing state not preserved: %+v", got)
	}
}

// ---------- Pagination tests ----------

func testPaginationCursor(t *testing.T, factory Factory) {
	s := factory(t)
	for i := range 5 {
		slug := "s-" + string(rune('a'+i))
		if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: slug, Name: "n"}); err != nil {
			t.Fatal(err)
		}
	}
	// Page 1.
	p1, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(p1.Items) != 2 {
		t.Fatalf("page 1 size: %d", len(p1.Items))
	}
	if p1.Cursor == "" {
		t.Fatal("page 1 missing cursor")
	}
	// Page 2.
	p2, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 2, Cursor: p1.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Items) != 2 {
		t.Fatalf("page 2 size: %d", len(p2.Items))
	}
	// Page 3: 1 item, no cursor (end).
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
	// No duplicates across pages.
	seen := map[string]bool{}
	for _, items := range [][]lic.LicenseScope{p1.Items, p2.Items, p3.Items} {
		for _, item := range items {
			if seen[item.ID] {
				t.Fatalf("duplicate ID %s across pages", item.ID)
			}
			seen[item.ID] = true
		}
	}
	if len(seen) != 5 {
		t.Fatalf("expected 5 unique IDs, got %d", len(seen))
	}
}

func testPaginationMalformed(t *testing.T, factory Factory) {
	s := factory(t)
	for i := range 3 {
		slug := "m-" + string(rune('a'+i))
		if _, err := s.CreateScope(lic.LicenseScopeInput{Slug: slug, Name: "n"}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListScopes(lic.LicenseScopeFilter{}, lic.PageRequest{Limit: 10, Cursor: "not-valid-base64!"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("malformed cursor should return all 3, got %d", len(page.Items))
	}
}

// ---------- Schema parity ----------

func testSchemaCanonical(t *testing.T, factory Factory) {
	s := factory(t)
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
			t.Fatalf("entity %s column count: got=%d want=%d",
				ent.Name, len(got[i].Columns), len(ent.Columns))
		}
	}
}

// ---------- Lifecycle state machine tests ----------

// fixedClock implements lic.Clock with a settable time.
type fixedClock struct{ now string }

// NowISO returns the pre-set timestamp string.
func (c fixedClock) NowISO() string { return c.now }

// helper to create a pending license inside a storage.
func createPendingLicense(t *testing.T, s lic.Storage) *lic.License {
	t.Helper()
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusPending, MaxUsages: 5,
	})
	if err != nil {
		t.Fatalf("createPendingLicense: %v", err)
	}
	return l
}

func testLifecycleActivate(t *testing.T, factory Factory) {
	s := factory(t)
	l := createPendingLicense(t, s)
	clk := fixedClock{now: "2026-06-01T12:00:00Z"}

	var activated *lic.License
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		activated, err = lic.Activate(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if activated.Status != lic.LicenseStatusActive {
		t.Fatalf("status = %s", activated.Status)
	}
	if activated.ActivatedAt == nil || !tsEqual(*activated.ActivatedAt, "2026-06-01T12:00:00Z") {
		t.Fatalf("activated_at = %v", *activated.ActivatedAt)
	}
	// Audit row written.
	audits, err := s.ListAudit(lic.AuditLogFilter{LicenseID: &l.ID, LicenseIDSet: true}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits.Items) != 1 || audits.Items[0].Event != "license.activated" {
		t.Fatalf("expected 1 audit row 'license.activated', got %d", len(audits.Items))
	}
}

func testLifecycleSuspendResume(t *testing.T, factory Factory) {
	s := factory(t)
	l := createPendingLicense(t, s)
	clk := fixedClock{now: "2026-06-01T12:00:00Z"}

	// Activate first.
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Activate(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	// Suspend.
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Suspend(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusSuspended {
		t.Fatalf("expected suspended, got %s", l.Status)
	}

	// Resume.
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Resume(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusActive {
		t.Fatalf("expected active after resume, got %s", l.Status)
	}

	// Verify through the storage that persisted status matches.
	got, err := s.GetLicense(l.ID)
	if err != nil || got == nil {
		t.Fatalf("GetLicense: %v", err)
	}
	if got.Status != lic.LicenseStatusActive {
		t.Fatalf("persisted status = %s", got.Status)
	}
}

func testLifecycleRevoke(t *testing.T, factory Factory) {
	s := factory(t)
	l := createPendingLicense(t, s)
	clk := fixedClock{now: "2026-06-01T12:00:00Z"}

	// Revoke from pending (terminal from any state).
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Revoke(tx, l, clk, lic.TransitionOptions{Actor: "admin"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusRevoked {
		t.Fatalf("expected revoked, got %s", l.Status)
	}

	// Further transitions must fail.
	err := s.WithTransaction(func(tx lic.StorageTx) error {
		_, err := lic.Activate(tx, l, clk, lic.TransitionOptions{})
		return err
	})
	if err == nil {
		t.Fatal("expected error activating revoked license")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseRevoked {
		t.Fatalf("expected LicenseRevoked, got %v", err)
	}
}

func testLifecycleEffectiveGrace(t *testing.T, factory Factory) {
	s := factory(t)
	expires := "2026-01-01T00:00:00Z"
	grace := "2026-01-08T00:00:00Z"
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
		ExpiresAt: &expires, GraceUntil: &grace,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Before expiry: still active.
	if got := lic.EffectiveStatus(l, "2025-12-31T23:59:59Z"); got != lic.LicenseStatusActive {
		t.Fatalf("before expiry: %s", got)
	}
	// During grace window.
	if got := lic.EffectiveStatus(l, "2026-01-04T00:00:00Z"); got != lic.LicenseStatusGrace {
		t.Fatalf("during grace: %s", got)
	}
	// Past grace.
	if got := lic.EffectiveStatus(l, "2026-01-09T00:00:00Z"); got != lic.LicenseStatusExpired {
		t.Fatalf("past grace: %s", got)
	}
}

func testLifecycleTickGrace(t *testing.T, factory Factory) {
	s := factory(t)
	expires := "2026-01-01T00:00:00Z"
	grace := "2026-01-08T00:00:00Z"
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
		ExpiresAt: &expires, GraceUntil: &grace,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Tick during grace window — should persist "grace".
	clk := fixedClock{now: "2026-01-04T00:00:00Z"}
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Tick(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusGrace {
		t.Fatalf("tick: status = %s, want grace", l.Status)
	}
	// Verify persisted.
	got, _ := s.GetLicense(l.ID)
	if got.Status != lic.LicenseStatusGrace {
		t.Fatalf("persisted = %s", got.Status)
	}

	// Tick past grace → expired.
	clk = fixedClock{now: "2026-01-09T00:00:00Z"}
	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Tick(tx, l, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusExpired {
		t.Fatalf("tick: status = %s, want expired", l.Status)
	}
}

func testLifecycleRenew(t *testing.T, factory Factory) {
	s := factory(t)
	expires := "2025-01-01T00:00:00Z"
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusExpired, MaxUsages: 5,
		ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}

	newExp := "2027-01-01T00:00:00Z"
	newGrace := "2027-01-08T00:00:00Z"
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	if err := s.WithTransaction(func(tx lic.StorageTx) error {
		var err error
		l, err = lic.Renew(tx, l, clk, lic.RenewOptions{
			ExpiresAt:     &newExp,
			GraceUntil:    &newGrace,
			GraceUntilSet: true,
		})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusActive {
		t.Fatalf("status = %s", l.Status)
	}
	if l.ExpiresAt == nil || !tsEqual(*l.ExpiresAt, newExp) {
		t.Fatalf("expires_at = %v", *l.ExpiresAt)
	}
	if l.GraceUntil == nil || !tsEqual(*l.GraceUntil, newGrace) {
		t.Fatalf("grace_until = %v", *l.GraceUntil)
	}
}

// ---------- Service layer tests ----------

func testServiceCreateLicense(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	// Auto-generated key.
	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		MaxUsages: 5,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatalf("CreateLicense: %v", err)
	}
	if l.Status != lic.LicenseStatusPending {
		t.Fatalf("status = %s, want pending", l.Status)
	}
	if l.LicenseKey == "" {
		t.Fatal("license_key should be auto-generated")
	}
	// Round-trip.
	got, err := s.GetLicense(l.ID)
	if err != nil || got == nil || got.LicenseKey != l.LicenseKey {
		t.Fatalf("round-trip: %v / %+v", err, got)
	}
	// Audit row.
	audits, err := s.ListAudit(lic.AuditLogFilter{LicenseID: &l.ID, LicenseIDSet: true}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits.Items) != 1 || audits.Items[0].Event != "license.created" {
		t.Fatalf("expected 1 audit 'license.created', got %d", len(audits.Items))
	}
}

func testServiceFindByKey(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		MaxUsages: 5,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// Case-insensitive lookup.
	lower := ""
	for _, c := range l.LicenseKey {
		if c >= 'A' && c <= 'Z' {
			lower += string(c + 32)
		} else {
			lower += string(c)
		}
	}
	found, err := lic.FindLicenseByKey(s, lower)
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.ID != l.ID {
		t.Fatalf("FindLicenseByKey: %+v", found)
	}

	// Invalid key shape.
	miss, err := lic.FindLicenseByKey(s, "bad-key")
	if err != nil {
		t.Fatal(err)
	}
	if miss != nil {
		t.Fatal("expected nil for invalid key")
	}
}

func testServiceRegisterUsage(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	// Create license with max_usages = 2.
	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		Status: lic.LicenseStatusActive, MaxUsages: 2,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}

	fp1 := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	fp2 := "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	fp3 := "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

	// Register seat 1.
	r1, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp1,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatalf("register 1: %v", err)
	}
	if !r1.Created {
		t.Fatal("expected created=true")
	}

	// Register seat 2.
	r2, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp2,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatalf("register 2: %v", err)
	}
	if !r2.Created {
		t.Fatal("expected created=true")
	}

	// Seat 3 should exceed limit.
	_, err = lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp3,
	}, lic.RegisterUsageOptions{})
	if err == nil {
		t.Fatal("expected SeatLimitExceeded")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeSeatLimitExceeded {
		t.Fatalf("expected SeatLimitExceeded, got %v", err)
	}
}

func testServiceRegisterIdempotent(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		Status: lic.LicenseStatusActive, MaxUsages: 1,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}

	fp := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	r1, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !r1.Created {
		t.Fatal("first should be created")
	}

	// Same fingerprint → idempotent, not a seat-limit error.
	r2, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatalf("idempotent re-register: %v", err)
	}
	if r2.Created {
		t.Fatal("second should not be created")
	}
	if r2.Usage.ID != r1.Usage.ID {
		t.Fatalf("expected same usage ID: %s vs %s", r2.Usage.ID, r1.Usage.ID)
	}
}

func testServiceAutoActivation(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		MaxUsages: 5, // defaults to pending
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if l.Status != lic.LicenseStatusPending {
		t.Fatalf("precondition: status = %s", l.Status)
	}

	fp := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	result, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatalf("registerUsage: %v", err)
	}
	if !result.Created {
		t.Fatal("expected created")
	}
	if result.License.Status != lic.LicenseStatusActive {
		t.Fatalf("license should be auto-activated, got %s", result.License.Status)
	}

	// Verify persisted.
	got, _ := s.GetLicense(l.ID)
	if got.Status != lic.LicenseStatusActive {
		t.Fatalf("persisted status = %s", got.Status)
	}
}

func testServiceRevokeUsage(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	l, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		Status: lic.LicenseStatusActive, MaxUsages: 5,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}

	fp := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	result, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: l.ID, Fingerprint: fp,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// Revoke.
	revoked, err := lic.RevokeUsage(s, clk, result.Usage.ID, lic.RevokeUsageOptions{})
	if err != nil {
		t.Fatalf("RevokeUsage: %v", err)
	}
	if revoked.Status != lic.UsageStatusRevoked {
		t.Fatalf("status = %s", revoked.Status)
	}

	// Re-revoking is a no-op.
	again, err := lic.RevokeUsage(s, clk, result.Usage.ID, lic.RevokeUsageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != lic.UsageStatusRevoked {
		t.Fatal("should still be revoked")
	}
}

// ---------- Scope service tests ----------

func testServiceCreateScope(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	scope, err := lic.CreateScope(s, clk, lic.CreateScopeInput{
		Slug: "acme", Name: "Acme Corp",
		Meta: map[string]any{"region": "us"},
	}, lic.CreateScopeOptions{Actor: "admin"})
	if err != nil {
		t.Fatalf("CreateScope: %v", err)
	}
	if scope.Slug != "acme" || scope.Name != "Acme Corp" {
		t.Fatalf("unexpected scope: %+v", scope)
	}

	// Audit row.
	audits, err := s.ListAudit(lic.AuditLogFilter{ScopeID: &scope.ID, ScopeIDSet: true}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range audits.Items {
		if a.Event == "scope.created" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected scope.created audit row")
	}
}

func testServiceCreateScopeDupSlug(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	_, err := lic.CreateScope(s, clk, lic.CreateScopeInput{
		Slug: "dup", Name: "First",
	}, lic.CreateScopeOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// Duplicate slug → UniqueConstraintViolation.
	_, err = lic.CreateScope(s, clk, lic.CreateScopeInput{
		Slug: "dup", Name: "Second",
	}, lic.CreateScopeOptions{})
	if err == nil {
		t.Fatal("expected error for duplicate slug")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

// ---------- Template service tests ----------

func testServiceCreateTemplate(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	tmpl, err := lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name:             "Pro Plan",
		MaxUsages:        5,
		TrialDurationSec: 604800, // 7 days
		GraceDurationSec: 259200, // 3 days
		Entitlements:     map[string]any{"feature_x": true},
	}, lic.CreateTemplateOptions{Actor: "admin"})
	if err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}
	if tmpl.Name != "Pro Plan" || tmpl.MaxUsages != 5 {
		t.Fatalf("unexpected: %+v", tmpl)
	}
	if tmpl.TrialDurationSec != 604800 || tmpl.GraceDurationSec != 259200 {
		t.Fatalf("durations wrong: trial=%d grace=%d", tmpl.TrialDurationSec, tmpl.GraceDurationSec)
	}

	// Audit row.
	audits, err := s.ListAudit(lic.AuditLogFilter{}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range audits.Items {
		if a.Event == "template.created" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected template.created audit row")
	}
}

func testServiceCreateTemplateValidation(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	// max_usages < 1 → rejected.
	_, err := lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name: "Bad", MaxUsages: 0,
	}, lic.CreateTemplateOptions{})
	if err == nil {
		t.Fatal("expected error for max_usages < 1")
	}

	// trial_duration_sec < 0 → rejected.
	_, err = lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name: "Bad", MaxUsages: 1, TrialDurationSec: -1,
	}, lic.CreateTemplateOptions{})
	if err == nil {
		t.Fatal("expected error for negative trial_duration_sec")
	}

	// grace_duration_sec < 0 → rejected.
	_, err = lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name: "Bad", MaxUsages: 1, GraceDurationSec: -1,
	}, lic.CreateTemplateOptions{})
	if err == nil {
		t.Fatal("expected error for negative grace_duration_sec")
	}
}

func testServiceCreateLicenseFromTemplate(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	tmpl, err := lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name:             "Trial",
		MaxUsages:        3,
		TrialDurationSec: 604800, // 7 days
		GraceDurationSec: 259200, // 3 days
		Entitlements:     map[string]any{"premium": true},
	}, lic.CreateTemplateOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// Create license from template with no overrides.
	l, err := lic.CreateLicenseFromTemplate(s, clk, lic.CreateLicenseFromTemplateInput{
		TemplateID:     tmpl.ID,
		LicensableType: "User",
		LicensableID:   "u1",
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatalf("CreateLicenseFromTemplate: %v", err)
	}

	// Template_id set.
	if l.TemplateID == nil || *l.TemplateID != tmpl.ID {
		t.Fatalf("template_id = %v, want %s", l.TemplateID, tmpl.ID)
	}

	// Max usages inherited.
	if l.MaxUsages != 3 {
		t.Fatalf("max_usages = %d, want 3", l.MaxUsages)
	}

	// Trial expiry: 2026-06-01 + 7 days = 2026-06-08.
	if l.ExpiresAt == nil {
		t.Fatal("expires_at should be computed from trial_duration_sec")
	}
	if !tsEqual(*l.ExpiresAt, "2026-06-08T00:00:00Z") {
		t.Fatalf("expires_at = %s, want 2026-06-08T00:00:00Z", *l.ExpiresAt)
	}

	// Grace: 2026-06-08 + 3 days = 2026-06-11.
	if l.GraceUntil == nil {
		t.Fatal("grace_until should be computed from grace_duration_sec")
	}
	if !tsEqual(*l.GraceUntil, "2026-06-11T00:00:00Z") {
		t.Fatalf("grace_until = %s, want 2026-06-11T00:00:00Z", *l.GraceUntil)
	}

	// Entitlements snapshotted into meta.
	ents, ok := l.Meta["entitlements"]
	if !ok {
		t.Fatal("meta should contain entitlements snapshot")
	}
	entsMap, ok := ents.(map[string]any)
	if !ok {
		t.Fatalf("entitlements is %T, want map[string]any", ents)
	}
	if entsMap["premium"] != true {
		t.Fatalf("entitlements.premium = %v", entsMap["premium"])
	}

	// Status defaults to pending.
	if l.Status != lic.LicenseStatusPending {
		t.Fatalf("status = %s, want pending", l.Status)
	}
}

func testServiceCreateLicenseFromTemplateOverrides(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	tmpl, err := lic.CreateTemplate(s, clk, lic.CreateTemplateInput{
		Name:             "Trial",
		MaxUsages:        3,
		TrialDurationSec: 604800,
		GraceDurationSec: 259200,
	}, lic.CreateTemplateOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// Override max_usages and explicitly null out expires_at.
	overrideMax := 10
	l, err := lic.CreateLicenseFromTemplate(s, clk, lic.CreateLicenseFromTemplateInput{
		TemplateID:     tmpl.ID,
		LicensableType: "User",
		LicensableID:   "u2",
		MaxUsages:      &overrideMax,
		ExpiresAt:      lic.OptStringOverride{Set: true, Value: nil}, // explicit null
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatalf("CreateLicenseFromTemplate with overrides: %v", err)
	}

	if l.MaxUsages != 10 {
		t.Fatalf("max_usages = %d, want 10", l.MaxUsages)
	}
	// Explicit null for expires_at should mean no expiry.
	if l.ExpiresAt != nil {
		t.Fatalf("expires_at = %v, want nil (explicit null override)", l.ExpiresAt)
	}
	// Grace should also be nil since expires_at is nil.
	if l.GraceUntil != nil {
		t.Fatalf("grace_until = %v, want nil", l.GraceUntil)
	}
}

// ---------- Token issuer tests ----------

func testServiceIssueToken(t *testing.T, factory Factory) {
	s := factory(t)
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	// Register the Ed25519 backend.
	registry := lic.NewAlgorithmRegistry()
	if err := registry.Register(ed25519.New()); err != nil {
		t.Fatal(err)
	}

	// Generate root key.
	rootPass := "root-pass-test-1234"
	root, err := lic.GenerateRootKey(s, clk, registry, lic.GenerateRootKeyInput{
		Alg:        lic.AlgEd25519,
		Passphrase: rootPass,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}

	// Issue signing key.
	sigPass := "signing-pass-test-5678"
	signing, err := lic.IssueInitialSigningKey(s, clk, registry, lic.IssueInitialSigningKeyInput{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    rootPass,
		SigningPassphrase: sigPass,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("IssueInitialSigningKey: %v", err)
	}
	if signing.Role != lic.RoleSigning || signing.State != lic.StateActive {
		t.Fatalf("signing key: role=%s state=%s", signing.Role, signing.State)
	}

	// Create an active license with entitlements in meta.
	license, err := lic.CreateLicense(s, clk, lic.CreateLicenseInput{
		LicensableType: "User",
		LicensableID:   "u1",
		Status:         lic.LicenseStatusActive,
		MaxUsages:      5,
		Meta:           map[string]any{"entitlements": map[string]any{"feature_x": true}},
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatalf("CreateLicense: %v", err)
	}

	// Register usage.
	fp := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	usageResult, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
		LicenseID: license.ID, Fingerprint: fp,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatalf("RegisterUsage: %v", err)
	}

	// Issue token.
	result, err := lic.IssueToken(s, clk, registry, lic.IssueTokenInput{
		License:           license,
		Usage:             usageResult.Usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: sigPass,
	})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	// Basic result checks.
	if result.Token == "" {
		t.Fatal("token should not be empty")
	}
	if !strings.HasPrefix(result.Token, "LIC1.") {
		t.Fatalf("token should start with LIC1., got prefix: %s", result.Token[:10])
	}
	if result.Kid != signing.Kid {
		t.Fatalf("kid = %s, want %s", result.Kid, signing.Kid)
	}
	if result.Exp != result.Iat+3600 {
		t.Fatalf("exp = %d, want iat+3600 = %d", result.Exp, result.Iat+3600)
	}
	if result.Jti == "" {
		t.Fatal("jti should not be empty")
	}

	// Decode unverified and check claims.
	parts, err := lic.DecodeUnverified(result.Token)
	if err != nil {
		t.Fatalf("DecodeUnverified: %v", err)
	}
	if parts.Header.Alg != lic.AlgEd25519 {
		t.Fatalf("header.alg = %s", parts.Header.Alg)
	}
	if parts.Header.Kid != signing.Kid {
		t.Fatalf("header.kid = %s", parts.Header.Kid)
	}
	if parts.Payload["license_id"] != license.ID {
		t.Fatalf("payload.license_id = %v", parts.Payload["license_id"])
	}
	if parts.Payload["usage_id"] != usageResult.Usage.ID {
		t.Fatalf("payload.usage_id = %v", parts.Payload["usage_id"])
	}
	if parts.Payload["status"] != "active" {
		t.Fatalf("payload.status = %v", parts.Payload["status"])
	}

	// Entitlements inherited from license.meta.
	ents, ok := parts.Payload["entitlements"]
	if !ok {
		t.Fatal("payload should contain entitlements")
	}
	entsMap, ok := ents.(map[string]any)
	if !ok {
		t.Fatalf("entitlements is %T, want map", ents)
	}
	if entsMap["feature_x"] != true {
		t.Fatalf("entitlements.feature_x = %v", entsMap["feature_x"])
	}

	// Verify token with the public key.
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind(signing.Kid, lic.AlgEd25519); err != nil {
		t.Fatal(err)
	}
	verified, err := lic.Verify(result.Token, lic.VerifyOptions{
		Registry: registry,
		Bindings: bindings,
		Keys: map[string]lic.KeyRecord{
			signing.Kid: {
				Kid: signing.Kid,
				Alg: lic.AlgEd25519,
				Pem: lic.PemKeyMaterial{PublicPem: signing.PublicPem},
			},
		},
	})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if verified.Header.Kid != signing.Kid {
		t.Fatalf("verified header.kid mismatch")
	}
}

// ---------- Delete tests ----------

func testDeleteLicense(t *testing.T, factory Factory) {
	s := factory(t)

	// Happy path: create, delete, verify gone.
	l, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLicense(l.ID); err != nil {
		t.Fatalf("DeleteLicense happy: %v", err)
	}
	got, err := s.GetLicense(l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("license still visible after delete")
	}

	// 404 on miss.
	err = s.DeleteLicense("00000000-0000-0000-0000-000000000000")
	if err == nil {
		t.Fatal("expected error on missing license")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseNotFound {
		t.Fatalf("expected LicenseNotFound, got %v", err)
	}

	// 409 when active usages exist.
	l2, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u2",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUsage(lic.LicenseUsageInput{
		LicenseID:    l2.ID,
		Fingerprint:  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		Status:       lic.UsageStatusActive,
		RegisteredAt: "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	err = s.DeleteLicense(l2.ID)
	if err == nil {
		t.Fatal("expected 409 for license with active usages")
	}
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}

	// But a license whose only usage is revoked CAN be deleted.
	l3, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u3",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUsage(lic.LicenseUsageInput{
		LicenseID:    l3.ID,
		Fingerprint:  "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		Status:       lic.UsageStatusRevoked,
		RegisteredAt: "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLicense(l3.ID); err != nil {
		t.Fatalf("license with only revoked usages should delete: %v", err)
	}
}

func testDeleteScope(t *testing.T, factory Factory) {
	s := factory(t)

	// Happy path.
	sc, err := s.CreateScope(lic.LicenseScopeInput{Slug: "del-me", Name: "Delete Me"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteScope(sc.ID); err != nil {
		t.Fatalf("DeleteScope happy: %v", err)
	}
	got, err := s.GetScope(sc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("scope still visible after delete")
	}

	// 404 on miss.
	err = s.DeleteScope("00000000-0000-0000-0000-000000000000")
	if err == nil {
		t.Fatal("expected error on missing scope")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseNotFound {
		t.Fatalf("expected LicenseNotFound, got %v", err)
	}

	// 409 when referenced by a license.
	scRef, err := s.CreateScope(lic.LicenseScopeInput{Slug: "ref-by-lic", Name: "Ref"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
		ScopeID: &scRef.ID,
	}); err != nil {
		t.Fatal(err)
	}
	err = s.DeleteScope(scRef.ID)
	if err == nil {
		t.Fatal("expected 409 for scope referenced by license")
	}
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}

	// 409 when referenced by a template.
	scT, err := s.CreateScope(lic.LicenseScopeInput{Slug: "ref-by-tmpl", Name: "Ref T"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTemplate(lic.LicenseTemplateInput{
		Name: "Template Scoped", MaxUsages: 1,
		ScopeID: &scT.ID,
	}); err != nil {
		t.Fatal(err)
	}
	err = s.DeleteScope(scT.ID)
	if err == nil {
		t.Fatal("expected 409 for scope referenced by template")
	}
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

func testDeleteTemplate(t *testing.T, factory Factory) {
	s := factory(t)

	// Happy path.
	tmpl, err := s.CreateTemplate(lic.LicenseTemplateInput{Name: "Delete Me", MaxUsages: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTemplate(tmpl.ID); err != nil {
		t.Fatalf("DeleteTemplate happy: %v", err)
	}
	got, err := s.GetTemplate(tmpl.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("template still visible after delete")
	}

	// 404 on miss.
	err = s.DeleteTemplate("00000000-0000-0000-0000-000000000000")
	if err == nil {
		t.Fatal("expected error on missing template")
	}
	var le *lic.Error
	if !errors.As(err, &le) || le.Code != lic.CodeLicenseNotFound {
		t.Fatalf("expected LicenseNotFound, got %v", err)
	}

	// 409 when referenced by a license.
	tRef, err := s.CreateTemplate(lic.LicenseTemplateInput{Name: "Ref Me", MaxUsages: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 3,
		TemplateID: &tRef.ID,
	}); err != nil {
		t.Fatal(err)
	}
	err = s.DeleteTemplate(tRef.ID)
	if err == nil {
		t.Fatal("expected 409 for template referenced by license")
	}
	if !errors.As(err, &le) || le.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}
