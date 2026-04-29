package postgres_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

func licInput(scopeID *string, lt, lid, key string) lic.LicenseInput {
	return lic.LicenseInput{
		ScopeID:        scopeID,
		LicensableType: lt,
		LicensableID:   lid,
		LicenseKey:     key,
		Status:         lic.LicenseStatusActive,
		MaxUsages:      5,
		Meta:           map[string]any{},
	}
}

func TestPostgres_FindByLicensable_AcrossScopes(t *testing.T) {
	s := freshPgStorage(t)
	scope1, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s1", Name: "S1", Meta: map[string]any{}})
	scope2, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s2", Name: "S2", Meta: map[string]any{}})

	_, _ = s.CreateLicense(licInput(&scope1.ID, "User", "u1", "LIC-A"))
	_, _ = s.CreateLicense(licInput(&scope2.ID, "User", "u1", "LIC-B"))
	_, _ = s.CreateLicense(licInput(nil, "User", "u1", "LIC-C"))
	_, _ = s.CreateLicense(licInput(&scope1.ID, "User", "u2", "LIC-D"))

	matches, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{Type: "User", ID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 3 {
		t.Fatalf("expected 3, got %d", len(matches))
	}
}

func TestPostgres_FindByLicensable_ScopedFilter(t *testing.T) {
	s := freshPgStorage(t)
	scope, _ := s.CreateScope(lic.LicenseScopeInput{Slug: "s1", Name: "S1", Meta: map[string]any{}})
	_, _ = s.CreateLicense(licInput(&scope.ID, "User", "u1", "LIC-A"))
	_, _ = s.CreateLicense(licInput(nil, "User", "u1", "LIC-B"))

	scoped, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User", ID: "u1", ScopeID: &scope.ID, ScopeIDSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scoped) != 1 {
		t.Fatalf("scoped: got %d, want 1", len(scoped))
	}

	globalOnly, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{
		Type: "User", ID: "u1", ScopeID: nil, ScopeIDSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(globalOnly) != 1 {
		t.Fatalf("global: got %d, want 1", len(globalOnly))
	}
	if globalOnly[0].ScopeID != nil {
		t.Fatalf("expected nil scope")
	}
}

func TestPostgres_FindByLicensable_NotFound(t *testing.T) {
	s := freshPgStorage(t)
	matches, err := s.FindLicensesByLicensable(lic.FindByLicensableQuery{Type: "User", ID: "u_nope"})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected 0, got %d", len(matches))
	}
}
