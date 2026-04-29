package licensing

import (
	"errors"
	"testing"
)

// fixedClock implements Clock with a fixed ISO timestamp.
type fixedClock struct {
	now string
}

func (c fixedClock) NowISO() string { return c.now }

// ---------- EffectiveStatus ----------

func TestEffectiveStatus_PassthroughStates(t *testing.T) {
	for _, s := range []LicenseStatus{
		LicenseStatusRevoked, LicenseStatusSuspended,
		LicenseStatusPending, LicenseStatusExpired,
	} {
		l := &License{Status: s}
		got := EffectiveStatus(l, "2026-06-01T00:00:00Z")
		if got != s {
			t.Errorf("EffectiveStatus(%s) = %s, want %s", s, got, s)
		}
	}
}

func TestEffectiveStatus_ActiveNoExpiry(t *testing.T) {
	l := &License{Status: LicenseStatusActive}
	got := EffectiveStatus(l, "2099-01-01T00:00:00Z")
	if got != LicenseStatusActive {
		t.Fatalf("got %s, want active", got)
	}
}

func TestEffectiveStatus_ActiveToGrace(t *testing.T) {
	expires := "2026-01-01T00:00:00Z"
	grace := "2026-01-08T00:00:00Z"
	l := &License{
		Status:     LicenseStatusActive,
		ExpiresAt:  &expires,
		GraceUntil: &grace,
	}
	// Before expiry → active.
	if got := EffectiveStatus(l, "2025-12-31T23:59:59Z"); got != LicenseStatusActive {
		t.Fatalf("before expiry: %s", got)
	}
	// At expiry → grace.
	if got := EffectiveStatus(l, "2026-01-01T00:00:00Z"); got != LicenseStatusGrace {
		t.Fatalf("at expiry: %s", got)
	}
	// During grace → grace.
	if got := EffectiveStatus(l, "2026-01-04T00:00:00Z"); got != LicenseStatusGrace {
		t.Fatalf("during grace: %s", got)
	}
	// Past grace → expired.
	if got := EffectiveStatus(l, "2026-01-08T00:00:00Z"); got != LicenseStatusExpired {
		t.Fatalf("past grace: %s", got)
	}
}

func TestEffectiveStatus_ActiveExpiredNoGrace(t *testing.T) {
	expires := "2026-01-01T00:00:00Z"
	l := &License{
		Status:    LicenseStatusActive,
		ExpiresAt: &expires,
	}
	if got := EffectiveStatus(l, "2026-01-02T00:00:00Z"); got != LicenseStatusExpired {
		t.Fatalf("got %s, want expired", got)
	}
}

// ---------- Transition tests using in-memory storage ----------
// These require a StorageTx. We'll use the memory adapter via the
// conformance test infrastructure. For unit-level tests of the
// lifecycle logic itself, we test EffectiveStatus above and test
// transitions via the full conformance suite. Below are focused
// tests for error paths.

// mockTx is a minimal StorageTx that tracks UpdateLicense and AppendAudit calls.
type mockTx struct {
	license     *License
	updateCalls int
	auditCalls  int
}

func (m *mockTx) UpdateLicense(_ string, patch LicensePatch) (*License, error) {
	m.updateCalls++
	l := *m.license
	if patch.Status != nil {
		l.Status = *patch.Status
	}
	if patch.ActivatedAt.Set {
		l.ActivatedAt = patch.ActivatedAt.Value
	}
	if patch.ExpiresAt.Set {
		l.ExpiresAt = patch.ExpiresAt.Value
	}
	if patch.GraceUntil.Set {
		l.GraceUntil = patch.GraceUntil.Value
	}
	m.license = &l
	return &l, nil
}

func (m *mockTx) AppendAudit(_ AuditLogInput) (*AuditLogEntry, error) {
	m.auditCalls++
	return &AuditLogEntry{ID: "audit-1"}, nil
}

// Stubs for the rest of StorageTx — not used by lifecycle functions.
func (m *mockTx) CreateLicense(_ LicenseInput) (*License, error) { return nil, nil }
func (m *mockTx) DeleteLicense(_ string) error                   { return nil }
func (m *mockTx) GetLicense(_ string) (*License, error)          { return nil, nil }
func (m *mockTx) GetLicenseByKey(_ string) (*License, error)     { return nil, nil }
func (m *mockTx) ListLicenses(_ LicenseFilter, _ PageRequest) (Page[License], error) {
	return Page[License]{}, nil
}
func (m *mockTx) FindLicensesByLicensable(_ FindByLicensableQuery) ([]License, error) {
	return nil, nil
}
func (m *mockTx) CreateScope(_ LicenseScopeInput) (*LicenseScope, error) { return nil, nil }
func (m *mockTx) GetScope(_ string) (*LicenseScope, error)               { return nil, nil }
func (m *mockTx) GetScopeBySlug(_ string) (*LicenseScope, error)         { return nil, nil }
func (m *mockTx) ListScopes(_ LicenseScopeFilter, _ PageRequest) (Page[LicenseScope], error) {
	return Page[LicenseScope]{}, nil
}
func (m *mockTx) UpdateScope(_ string, _ LicenseScopePatch) (*LicenseScope, error) { return nil, nil }
func (m *mockTx) DeleteScope(_ string) error                                       { return nil }
func (m *mockTx) CreateTemplate(_ LicenseTemplateInput) (*LicenseTemplate, error)  { return nil, nil }
func (m *mockTx) GetTemplate(_ string) (*LicenseTemplate, error)                   { return nil, nil }
func (m *mockTx) ListTemplates(_ LicenseTemplateFilter, _ PageRequest) (Page[LicenseTemplate], error) {
	return Page[LicenseTemplate]{}, nil
}
func (m *mockTx) UpdateTemplate(_ string, _ LicenseTemplatePatch) (*LicenseTemplate, error) {
	return nil, nil
}
func (m *mockTx) DeleteTemplate(_ string) error                          { return nil }
func (m *mockTx) CreateUsage(_ LicenseUsageInput) (*LicenseUsage, error) { return nil, nil }
func (m *mockTx) GetUsage(_ string) (*LicenseUsage, error)               { return nil, nil }
func (m *mockTx) ListUsages(_ LicenseUsageFilter, _ PageRequest) (Page[LicenseUsage], error) {
	return Page[LicenseUsage]{}, nil
}
func (m *mockTx) UpdateUsage(_ string, _ LicenseUsagePatch) (*LicenseUsage, error) { return nil, nil }
func (m *mockTx) CreateKey(_ LicenseKeyInput) (*LicenseKey, error)                 { return nil, nil }
func (m *mockTx) GetKey(_ string) (*LicenseKey, error)                             { return nil, nil }
func (m *mockTx) GetKeyByKid(_ string) (*LicenseKey, error)                        { return nil, nil }
func (m *mockTx) ListKeys(_ LicenseKeyFilter, _ PageRequest) (Page[LicenseKey], error) {
	return Page[LicenseKey]{}, nil
}
func (m *mockTx) UpdateKey(_ string, _ LicenseKeyPatch) (*LicenseKey, error) { return nil, nil }
func (m *mockTx) GetAudit(_ string) (*AuditLogEntry, error)                  { return nil, nil }
func (m *mockTx) ListAudit(_ AuditLogFilter, _ PageRequest) (Page[AuditLogEntry], error) {
	return Page[AuditLogEntry]{}, nil
}

// ---------- Activate ----------

func TestActivate_PendingToActive(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusPending}
	tx := &mockTx{license: l}
	clk := fixedClock{now: "2026-01-01T00:00:00Z"}

	result, err := Activate(tx, l, clk, TransitionOptions{})
	if err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if result.Status != LicenseStatusActive {
		t.Fatalf("status = %s, want active", result.Status)
	}
	if result.ActivatedAt == nil || *result.ActivatedAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("activated_at = %v", result.ActivatedAt)
	}
	if tx.updateCalls != 1 || tx.auditCalls != 1 {
		t.Fatalf("calls: update=%d audit=%d", tx.updateCalls, tx.auditCalls)
	}
}

func TestActivate_AlreadyActive_NoOp(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusActive}
	tx := &mockTx{license: l}
	result, err := Activate(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result != l {
		t.Fatal("expected same pointer (no-op)")
	}
	if tx.updateCalls != 0 {
		t.Fatal("should not call update for no-op")
	}
}

func TestActivate_RevokedRejected(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusRevoked}
	tx := &mockTx{license: l}
	_, err := Activate(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err == nil {
		t.Fatal("expected error for revoked")
	}
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeLicenseRevoked {
		t.Fatalf("expected LicenseRevoked, got %v", err)
	}
}

func TestActivate_SuspendedRejected(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusSuspended}
	tx := &mockTx{license: l}
	_, err := Activate(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err == nil {
		t.Fatal("expected error")
	}
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeIllegalLifecycleTransition {
		t.Fatalf("expected IllegalLifecycleTransition, got %v", err)
	}
}

// ---------- Suspend ----------

func TestSuspend_ActiveToSuspended(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusActive}
	tx := &mockTx{license: l}
	result, err := Suspend(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusSuspended {
		t.Fatalf("status = %s", result.Status)
	}
}

func TestSuspend_AlreadySuspended_NoOp(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusSuspended}
	tx := &mockTx{license: l}
	result, err := Suspend(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result != l {
		t.Fatal("expected no-op")
	}
}

// ---------- Resume ----------

func TestResume_SuspendedToActive(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusSuspended}
	tx := &mockTx{license: l}
	result, err := Resume(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusActive {
		t.Fatalf("status = %s", result.Status)
	}
}

func TestResume_ActiveRejected(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusActive}
	tx := &mockTx{license: l}
	_, err := Resume(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------- Revoke ----------

func TestRevoke_AnyToRevoked(t *testing.T) {
	for _, s := range []LicenseStatus{
		LicenseStatusActive, LicenseStatusPending,
		LicenseStatusSuspended, LicenseStatusExpired, LicenseStatusGrace,
	} {
		l := &License{ID: "l1", Status: s}
		tx := &mockTx{license: l}
		result, err := Revoke(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
		if err != nil {
			t.Fatalf("Revoke(%s): %v", s, err)
		}
		if result.Status != LicenseStatusRevoked {
			t.Fatalf("Revoke(%s) → %s", s, result.Status)
		}
	}
}

func TestRevoke_AlreadyRevoked_NoOp(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusRevoked}
	tx := &mockTx{license: l}
	result, err := Revoke(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result != l {
		t.Fatal("expected no-op")
	}
}

// ---------- Expire ----------

func TestExpire_ActiveToExpired(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusActive}
	tx := &mockTx{license: l}
	result, err := Expire(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusExpired {
		t.Fatalf("status = %s", result.Status)
	}
}

func TestExpire_PendingRejected(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusPending}
	tx := &mockTx{license: l}
	_, err := Expire(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------- Renew ----------

func TestRenew_ExpiredToActive(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusExpired}
	tx := &mockTx{license: l}
	newExp := "2027-01-01T00:00:00Z"
	newGrace := "2027-01-08T00:00:00Z"
	result, err := Renew(tx, l, fixedClock{now: "2026-06-01T00:00:00Z"}, RenewOptions{
		ExpiresAt:     &newExp,
		GraceUntil:    &newGrace,
		GraceUntilSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusActive {
		t.Fatalf("status = %s", result.Status)
	}
	if result.ExpiresAt == nil || *result.ExpiresAt != newExp {
		t.Fatalf("expires_at = %v", result.ExpiresAt)
	}
	if result.GraceUntil == nil || *result.GraceUntil != newGrace {
		t.Fatalf("grace_until = %v", result.GraceUntil)
	}
}

func TestRenew_SuspendedRejected(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusSuspended}
	tx := &mockTx{license: l}
	_, err := Renew(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, RenewOptions{})
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------- Tick ----------

func TestTick_ActiveToGrace(t *testing.T) {
	expires := "2026-01-01T00:00:00Z"
	grace := "2026-01-08T00:00:00Z"
	l := &License{ID: "l1", Status: LicenseStatusActive, ExpiresAt: &expires, GraceUntil: &grace}
	tx := &mockTx{license: l}
	result, err := Tick(tx, l, fixedClock{now: "2026-01-04T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusGrace {
		t.Fatalf("status = %s, want grace", result.Status)
	}
}

func TestTick_GraceToExpired(t *testing.T) {
	expires := "2026-01-01T00:00:00Z"
	grace := "2026-01-08T00:00:00Z"
	l := &License{ID: "l1", Status: LicenseStatusActive, ExpiresAt: &expires, GraceUntil: &grace}
	tx := &mockTx{license: l}
	result, err := Tick(tx, l, fixedClock{now: "2026-01-09T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != LicenseStatusExpired {
		t.Fatalf("status = %s, want expired", result.Status)
	}
}

func TestTick_NoChange(t *testing.T) {
	l := &License{ID: "l1", Status: LicenseStatusActive}
	tx := &mockTx{license: l}
	result, err := Tick(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result != l {
		t.Fatal("expected no-op when effective status matches")
	}
	if tx.updateCalls != 0 {
		t.Fatal("should not call update for no-op")
	}
}

// ---------- Actor attribution ----------

func TestAuditActorDefaults(t *testing.T) {
	// Verify the default actor is "system" when not specified.
	l := &License{ID: "l1", Status: LicenseStatusPending}
	var capturedActor string
	tx := &auditCaptureTx{
		mockTx:       mockTx{license: l},
		captureActor: func(a string) { capturedActor = a },
	}
	if _, err := Activate(tx, l, fixedClock{now: "2026-01-01T00:00:00Z"}, TransitionOptions{}); err != nil {
		t.Fatal(err)
	}
	if capturedActor != "system" {
		t.Fatalf("default actor = %q, want system", capturedActor)
	}
}

type auditCaptureTx struct {
	captureActor func(string)
	mockTx
}

func (a *auditCaptureTx) AppendAudit(in AuditLogInput) (*AuditLogEntry, error) {
	a.captureActor(in.Actor)
	return a.mockTx.AppendAudit(in)
}
