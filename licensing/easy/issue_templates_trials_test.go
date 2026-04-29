package easy_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

const pepper = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 32 chars

func mkTemplate(t *testing.T, db lic.Storage, name string, mut func(*lic.LicenseTemplateInput)) *lic.LicenseTemplate {
	t.Helper()
	in := lic.LicenseTemplateInput{
		Name:             name,
		MaxUsages:        5,
		TrialDurationSec: 0,
		GraceDurationSec: 0,
		Entitlements:     map[string]any{},
		Meta:             map[string]any{},
	}
	if mut != nil {
		mut(&in)
	}
	tmpl, err := db.CreateTemplate(in)
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	return tmpl
}

func TestIssue_InheritsMaxUsagesFromTemplate(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	tmpl := mkTemplate(t, db, "pro", func(in *lic.LicenseTemplateInput) {
		in.MaxUsages = 10
		in.Entitlements = map[string]any{"tier": "pro"}
	})
	license, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_1",
		TemplateID:     &tmpl.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if license.MaxUsages != 10 {
		t.Fatalf("max_usages: want 10, got %d", license.MaxUsages)
	}
	ent, ok := license.Meta["entitlements"].(map[string]any)
	if !ok || ent["tier"] != "pro" {
		t.Fatalf("entitlements not propagated: %v", license.Meta["entitlements"])
	}
}

func TestIssue_PerCallMaxUsagesOverridesTemplate(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	tmpl := mkTemplate(t, db, "pro", func(in *lic.LicenseTemplateInput) { in.MaxUsages = 10 })
	license, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_2",
		TemplateID:     &tmpl.ID,
		MaxUsages:      50,
		MaxUsagesSet:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if license.MaxUsages != 50 {
		t.Fatalf("override failed: got %d", license.MaxUsages)
	}
}

func TestIssue_ChildTemplateMergesEntitlements(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	parent := mkTemplate(t, db, "parent", func(in *lic.LicenseTemplateInput) {
		in.Entitlements = map[string]any{"tier": "basic", "seats": 5}
	})
	child := mkTemplate(t, db, "child", func(in *lic.LicenseTemplateInput) {
		in.ParentID = &parent.ID
		in.MaxUsages = 10
		in.Entitlements = map[string]any{"tier": "pro"}
	})
	license, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_3",
		TemplateID:     &child.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	ent := license.Meta["entitlements"].(map[string]any)
	// Note: the resolver merges into a typed map but our scan reads back as
	// generic map[string]any after JSON round-trip; numeric becomes float64.
	if ent["tier"] != "pro" {
		t.Fatalf("tier: want pro, got %v", ent["tier"])
	}
	// seats survives from parent.
	if ent["seats"] == nil {
		t.Fatalf("seats not inherited from parent: %v", ent)
	}
}

func TestIssue_RequiresMaxUsagesWithoutTemplate(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_4",
		// no TemplateID, no MaxUsages
	})
	if err == nil || !strings.Contains(err.Error(), "MaxUsages") {
		t.Fatalf("expected MaxUsages error, got %v", err)
	}
}

func TestIssue_TrialDedupe(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:          db,
		Signing:     &easy.SigningConfig{Passphrase: passphrase},
		TrialPepper: pepper,
	})
	if err != nil {
		t.Fatal(err)
	}
	cooldown := 86400
	tmpl := mkTemplate(t, db, "trial", func(in *lic.LicenseTemplateInput) {
		in.TrialDurationSec = 86400
		in.TrialCooldownSec = &cooldown
	})
	_, err = issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_a",
		TemplateID:     &tmpl.ID,
		IsTrial:        true,
		Fingerprint:    "fp-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_a2",
		TemplateID:     &tmpl.ID,
		IsTrial:        true,
		Fingerprint:    "fp-1",
	})
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeTrialAlreadyIssued {
		t.Fatalf("expected CodeTrialAlreadyIssued, got %v", err)
	}
}

func TestIssue_TrialDifferentFingerprintsBothSucceed(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:          db,
		Signing:     &easy.SigningConfig{Passphrase: passphrase},
		TrialPepper: pepper,
	})
	if err != nil {
		t.Fatal(err)
	}
	tmpl := mkTemplate(t, db, "trial", func(in *lic.LicenseTemplateInput) {
		in.TrialDurationSec = 86400
	})
	if _, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User", LicensableID: "u_x", TemplateID: &tmpl.ID,
		IsTrial: true, Fingerprint: "fp-a",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User", LicensableID: "u_y", TemplateID: &tmpl.ID,
		IsTrial: true, Fingerprint: "fp-b",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestIssue_TrialWithoutPepperErrors(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
		// No TrialPepper.
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_n",
		MaxUsages:      1,
		MaxUsagesSet:   true,
		IsTrial:        true,
		Fingerprint:    "fp",
	})
	if err == nil || !strings.Contains(err.Error(), "TrialPepper") {
		t.Fatalf("expected TrialPepper error, got %v", err)
	}
}

func TestIssue_TrialWithoutFingerprintErrors(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:          db,
		Signing:     &easy.SigningConfig{Passphrase: passphrase},
		TrialPepper: pepper,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_n",
		MaxUsages:      1,
		MaxUsagesSet:   true,
		IsTrial:        true,
		// no Fingerprint
	})
	if err == nil || !strings.Contains(err.Error(), "Fingerprint") {
		t.Fatalf("expected Fingerprint error, got %v", err)
	}
}
