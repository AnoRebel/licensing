package client

import (
	"errors"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

func TestValidate_HappyPath(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)

	tok := issueTestToken(t, basePayload(now))
	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.LicenseID != "lic-1" || res.UsageID != "use-1" {
		t.Fatalf("claim drift: %+v", res)
	}
	if res.Status != "active" {
		t.Fatalf("status drift: %s", res.Status)
	}
}

func TestValidate_TokenExpired(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["exp"] = now - 100
	p["nbf"] = now - 200
	p["iat"] = now - 200

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("expected ErrTokenExpired, got %v", err)
	}
}

func TestValidate_TokenNotYetValid(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["nbf"] = now + 3600
	p["iat"] = now
	p["exp"] = now + 7200

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrTokenNotYetValid) {
		t.Fatalf("expected ErrTokenNotYetValid, got %v", err)
	}
}

func TestValidate_SkewWindowAllowsNearExpiry(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["exp"] = now - 30 // expired 30s ago
	p["iat"] = now - 3600
	p["nbf"] = now - 3600

	tok := issueTestToken(t, p)
	// With default 60s skew, 30s past exp should still be valid.
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if err != nil {
		t.Fatalf("expected skew window to allow, got %v", err)
	}
}

func TestValidate_LicenseRevoked(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["status"] = "revoked"

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("expected ErrLicenseRevoked, got %v", err)
	}
}

func TestValidate_LicenseSuspended(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["status"] = "suspended"

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrLicenseSuspended) {
		t.Fatalf("expected ErrLicenseSuspended, got %v", err)
	}
}

func TestValidate_ForceOnlineAfterPassed(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["force_online_after"] = now - 1

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrRequiresOnlineRefresh) {
		t.Fatalf("expected ErrRequiresOnlineRefresh, got %v", err)
	}
}

func TestValidate_FingerprintMismatch(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)

	tok := issueTestToken(t, basePayload(now))
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "different-fp", NowSec: now,
	})
	if !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("expected ErrFingerprintMismatch, got %v", err)
	}
}

func TestValidate_MissingRequiredClaim(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	delete(p, "license_id")

	tok := issueTestToken(t, p)
	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if !errors.Is(err, ErrInvalidTokenFormat) {
		t.Fatalf("expected ErrInvalidTokenFormat, got %v", err)
	}
	if !strings.Contains(err.Error(), "license_id") {
		t.Fatalf("error should mention missing claim: %v", err)
	}
}

func TestValidate_TamperedSignatureFails(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	// Flip a byte in the signature.
	segs := strings.Split(tok, ".")
	raw, _ := lic.Base64urlDecode(segs[3])
	raw[0] ^= 0x01
	segs[3] = lic.Base64urlEncode(raw)
	tampered := strings.Join(segs, ".")

	_, err := Validate(tampered, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if err == nil {
		t.Fatal("expected error on tampered sig")
	}
}

func TestPeek_ExtractsLifetimeClaims(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	foa := now + 1000
	p["force_online_after"] = foa

	tok := issueTestToken(t, p)
	peek, err := Peek(tok)
	if err != nil {
		t.Fatalf("peek: %v", err)
	}
	if peek.Kid != "test-kid" {
		t.Fatalf("kid drift: %s", peek.Kid)
	}
	if peek.Exp != now+3600 {
		t.Fatalf("exp drift: %d", peek.Exp)
	}
	if peek.ForceOnlineAfter == nil || *peek.ForceOnlineAfter != foa {
		t.Fatalf("foa drift: %v", peek.ForceOnlineAfter)
	}
}

func TestPeek_NoForceOnlineAfter(t *testing.T) {
	now := int64(1700000000)
	tok := issueTestToken(t, basePayload(now))
	peek, err := Peek(tok)
	if err != nil {
		t.Fatal(err)
	}
	if peek.ForceOnlineAfter != nil {
		t.Fatalf("expected nil foa, got %v", *peek.ForceOnlineAfter)
	}
}

func TestPeek_MalformedToken(t *testing.T) {
	_, err := Peek("not-a-lic1-token")
	if err == nil {
		t.Fatal("expected error on malformed")
	}
}
