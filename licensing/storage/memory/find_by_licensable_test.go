package memory_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

// Mirrors typescript/tests/storage-memory/find-by-licensable.test.ts.

func licInput(t lic.LicenseStatus, scopeID *string, lt, lid, key string) lic.LicenseInput {
	return lic.LicenseInput{
		ScopeID:        scopeID,
		LicensableType: lt,
		LicensableID:   lid,
		LicenseKey:     key,
		Status:         t,
		MaxUsages:      5,
		Meta:           map[string]any{},
	}
}

func TestMemory_FindByLicensable_AcrossScopes(t *testing.T) {
	s := memory.New(memory.Options{})
	scope1, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s1", Name: "Scope 1", Meta: map[string]any{}})
	scope2, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s2", Name: "Scope 2", Meta: map[string]any{}})

	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, &scope1.ID, "User", "u1", "LIC-A"))
	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, &scope2.ID, "User", "u1", "LIC-B"))
	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, nil, "User", "u1", "LIC-C")) // global
	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, &scope1.ID, "User", "u2", "LIC-D"))

	matches, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User",
		ID:   "u1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 3 {
		t.Fatalf("expected 3 matches, got %d", len(matches))
	}
}

func TestMemory_FindByLicensable_ScopedFilter(t *testing.T) {
	s := memory.New(memory.Options{})
	scope, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s1", Name: "S1", Meta: map[string]any{}})
	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, &scope.ID, "User", "u1", "LIC-A"))
	_, _ = s.CreateLicense(licInput(lic.LicenseStatusActive, nil, "User", "u1", "LIC-B"))

	scoped, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User", ID: "u1", ScopeID: &scope.ID, ScopeIDSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scoped) != 1 {
		t.Fatalf("expected 1 scoped match, got %d", len(scoped))
	}
	if scoped[0].ScopeID == nil || *scoped[0].ScopeID != scope.ID {
		t.Fatalf("expected scoped match, got %v", scoped[0].ScopeID)
	}

	globalOnly, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User", ID: "u1", ScopeID: nil, ScopeIDSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(globalOnly) != 1 {
		t.Fatalf("expected 1 global match, got %d", len(globalOnly))
	}
	if globalOnly[0].ScopeID != nil {
		t.Fatalf("expected nil scope on global match, got %v", globalOnly[0].ScopeID)
	}
}

func TestMemory_FindByLicensable_NotFound(t *testing.T) {
	s := memory.New(memory.Options{})
	matches, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User", ID: "u_nope",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected 0 matches, got %d", len(matches))
	}
}
