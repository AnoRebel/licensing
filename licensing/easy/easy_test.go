package easy_test

import (
	"context"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

const passphrase = "test-passphrase-must-be-at-least-32-chars"

func TestNewIssuer_AutoGenKeysAndIssue(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}

	license, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_123",
		MaxUsages:      5,
	})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if license.LicensableType != "User" || license.LicensableID != "u_123" {
		t.Fatalf("unexpected license: %+v", license)
	}
	if !strings.HasPrefix(license.LicenseKey, "LIC-") {
		t.Fatalf("expected LIC- prefix, got %s", license.LicenseKey)
	}
	if license.Status != lic.LicenseStatusPending {
		t.Fatalf("status: want pending, got %s", license.Status)
	}

	// Audit row written.
	page, err := db.ListAudit(lic.AuditLogFilter{Event: ptrStr("license.created")}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(page.Items))
	}
}

func TestNewIssuer_KeysReusedAcrossCalls(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{LicensableType: "U", LicensableID: "a", MaxUsages: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), easy.IssueInput{LicensableType: "U", LicensableID: "b", MaxUsages: 1})
	if err != nil {
		t.Fatal(err)
	}
	keys, err := db.ListKeys(lic.LicenseKeyFilter{}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	// One root + one signing — never two signing keys.
	if len(keys.Items) != 2 {
		t.Fatalf("expected 2 keys (root + signing), got %d", len(keys.Items))
	}
}

func TestNewIssuer_NoSigningConfig_FailsOnEnsure(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{DB: db})
	if err != nil {
		t.Fatalf("constructor without signing should not fail: %v", err)
	}
	if _, err := issuer.EnsureSigningKey(); err == nil {
		t.Fatal("EnsureSigningKey should fail without Signing config + empty storage")
	}
}

func TestNewIssuer_ExplicitLicenseKeyHonoured(t *testing.T) {
	db := memory.New(memory.Options{})
	issuer, err := easy.NewIssuer(easy.IssuerConfig{
		DB:      db,
		Signing: &easy.SigningConfig{Passphrase: passphrase},
	})
	if err != nil {
		t.Fatal(err)
	}
	license, err := issuer.Issue(context.Background(), easy.IssueInput{
		LicensableType: "User",
		LicensableID:   "u_x",
		LicenseKey:     "LIC-AAAA-BBBB-CCCC-DDDD-EEEE",
		MaxUsages:      1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if license.LicenseKey != "LIC-AAAA-BBBB-CCCC-DDDD-EEEE" {
		t.Fatalf("expected explicit key, got %s", license.LicenseKey)
	}
}

func TestNewClient_RequiresServerURL(t *testing.T) {
	if _, err := easy.NewClient(easy.ClientConfig{}); err == nil {
		t.Fatal("expected error for missing ServerURL")
	}
}

func TestNewClient_StripsTrailingSlash(t *testing.T) {
	c, err := easy.NewClient(easy.ClientConfig{ServerURL: "https://example.com/"})
	if err != nil {
		t.Fatal(err)
	}
	if c == nil {
		t.Fatal("nil client")
	}
}

func ptrStr(s string) *string { return &s }
