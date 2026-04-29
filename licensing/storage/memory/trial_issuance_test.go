package memory_test

import (
	"errors"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

const (
	fpA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fpB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func freshTemplate(t *testing.T, s *memory.Storage, name string) string {
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

func TestMemory_TrialIssuance_RecordAndFind(t *testing.T) {
	s := memory.New(memory.Options{})
	tmpl := freshTemplate(t, s, "t1")
	r, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{
		TemplateID: &tmpl, FingerprintHash: fpA,
	})
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.FindTrialIssuance(lic.TrialIssuanceLookup{
		TemplateID: &tmpl, FingerprintHash: fpA,
	})
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.ID != r.ID {
		t.Fatalf("find mismatch: %v vs %s", found, r.ID)
	}
}

func TestMemory_TrialIssuance_RejectsDuplicate(t *testing.T) {
	s := memory.New(memory.Options{})
	tmpl := freshTemplate(t, s, "t1")
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

func TestMemory_TrialIssuance_NullTemplateGroup(t *testing.T) {
	s := memory.New(memory.Options{})
	_, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpA})
	if err == nil || !strings.Contains(err.Error(), "template_fingerprint") {
		t.Fatalf("expected dup violation on null/fpA, got %v", err)
	}
	r, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: nil, FingerprintHash: fpB})
	if err != nil || r.TemplateID != nil {
		t.Fatalf("unexpected: r=%v err=%v", r, err)
	}
}

func TestMemory_TrialIssuance_DifferentTemplatesShareFingerprint(t *testing.T) {
	s := memory.New(memory.Options{})
	t1 := freshTemplate(t, s, "t1")
	t2 := freshTemplate(t, s, "t2")
	_, err := s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &t1, FingerprintHash: fpA})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RecordTrialIssuance(lic.TrialIssuanceInput{TemplateID: &t2, FingerprintHash: fpA})
	if err != nil {
		t.Fatalf("different templates should accept the same fingerprint, got %v", err)
	}
}

func TestMemory_TrialIssuance_DeleteFreesSlot(t *testing.T) {
	s := memory.New(memory.Options{})
	tmpl := freshTemplate(t, s, "t1")
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
