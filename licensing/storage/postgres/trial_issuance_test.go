package postgres_test

import (
	"errors"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/postgres"
)

const (
	fpA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fpB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func freshPgTemplate(t *testing.T, s *postgres.Storage, name string) string {
	t.Helper()
	tmpl, err := s.CreateTemplate(lic.LicenseTemplateInput{
		ScopeID:          nil,
		ParentID:         nil,
		Name:             name,
		MaxUsages:        5,
		TrialDurationSec: 86400,
		TrialCooldownSec: nil,
		GraceDurationSec: 0,
		Entitlements:     map[string]any{},
		Meta:             map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return tmpl.ID
}

func TestPostgres_TrialIssuance_RecordAndFind(t *testing.T) {
	s := freshPgStorage(t)
	tmpl := freshPgTemplate(t, s, "t1")
	r, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &tmpl, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.FindTrialIssuance(lic.TrialIssuanceLookup{TemplateID: &tmpl, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.ID != r.ID {
		t.Fatalf("find mismatch: %v vs %s", found, r.ID)
	}
}

func TestPostgres_TrialIssuance_RejectsDuplicate(t *testing.T) {
	s := freshPgStorage(t)
	tmpl := freshPgTemplate(t, s, "t1")
	_, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &tmpl, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &tmpl, FingerprintHash: fpA})
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeUniqueConstraintViolation {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

func TestPostgres_TrialIssuance_NullTemplateGroup(t *testing.T) {
	s := freshPgStorage(t)
	_, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpA})
	if err == nil {
		t.Fatal("expected dup violation")
	}
	r, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpB})
	if err != nil || r.TemplateID != nil {
		t.Fatalf("unexpected: r=%v err=%v", r, err)
	}
}

func TestPostgres_TrialIssuance_DeleteFreesSlot(t *testing.T) {
	s := freshPgStorage(t)
	tmpl := freshPgTemplate(t, s, "t1")
	first, _ := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &tmpl, FingerprintHash: fpA})
	if err := s.DeleteTrialIssuance(first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &tmpl, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID {
		t.Fatal("expected fresh id after delete + re-record")
	}
}
