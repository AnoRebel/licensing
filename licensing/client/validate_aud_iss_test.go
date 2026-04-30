package client

import (
	"errors"
	"testing"
)

// Optional `aud` (audience) and `iss` (issuer) claim validation.
//
// Both claims are advisory by default — when the verifier does not pin
// an expected value, the claims are parsed if present (so they round-trip
// into the result) but never enforced. When the verifier pins an
// expected value, mismatches surface as
// *ClientError{Code: CodeAudienceMismatch | CodeIssuerMismatch}.

func TestValidate_AudStringMatchesPin(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = "app-a"
	tok := issueTestToken(t, p)

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-a",
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(res.Aud) != 1 || res.Aud[0] != "app-a" {
		t.Fatalf("aud round-trip drift: %+v", res.Aud)
	}
}

func TestValidate_AudArrayContainsPin(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = []any{"app-a", "app-b", "app-c"}
	tok := issueTestToken(t, p)

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-b",
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(res.Aud) != 3 {
		t.Fatalf("aud round-trip drift: %+v", res.Aud)
	}
}

func TestValidate_AudStringMismatch(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = "app-a"
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-b",
	})
	if !errors.Is(err, ErrAudienceMismatch) {
		t.Fatalf("want ErrAudienceMismatch, got %v", err)
	}
}

func TestValidate_AudArrayLacksPin(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = []any{"app-a", "app-b"}
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-c",
	})
	if !errors.Is(err, ErrAudienceMismatch) {
		t.Fatalf("want ErrAudienceMismatch, got %v", err)
	}
}

func TestValidate_AudPinButNoAudClaim(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-a",
	})
	if !errors.Is(err, ErrAudienceMismatch) {
		t.Fatalf("want ErrAudienceMismatch, got %v", err)
	}
}

func TestValidate_AudUnpinnedIsAdvisory(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = "app-a"
	tok := issueTestToken(t, p)

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
		// no ExpectedAudience
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(res.Aud) != 1 || res.Aud[0] != "app-a" {
		t.Fatalf("aud not surfaced when unpinned: %+v", res.Aud)
	}
}

func TestValidate_AudWrongTypeIsRejected(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = int64(42)
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	var ce *ClientError
	if !errors.As(err, &ce) || ce.Code != CodeInvalidTokenFormat {
		t.Fatalf("want InvalidTokenFormat, got %v", err)
	}
}

func TestValidate_AudArrayWithNonStringIsRejected(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = []any{"app-a", int64(7)}
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	var ce *ClientError
	if !errors.As(err, &ce) || ce.Code != CodeInvalidTokenFormat {
		t.Fatalf("want InvalidTokenFormat, got %v", err)
	}
}

func TestValidate_IssMatchesPin(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["iss"] = "https://issuer.example"
	tok := issueTestToken(t, p)

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:    "fp-1",
		NowSec:         now,
		ExpectedIssuer: "https://issuer.example",
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.Iss == nil || *res.Iss != "https://issuer.example" {
		t.Fatalf("iss round-trip drift: %v", res.Iss)
	}
}

func TestValidate_IssMismatch(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["iss"] = "https://attacker.example"
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:    "fp-1",
		NowSec:         now,
		ExpectedIssuer: "https://issuer.example",
	})
	if !errors.Is(err, ErrIssuerMismatch) {
		t.Fatalf("want ErrIssuerMismatch, got %v", err)
	}
}

func TestValidate_IssPinButNoIssClaim(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	tok := issueTestToken(t, basePayload(now))

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:    "fp-1",
		NowSec:         now,
		ExpectedIssuer: "https://issuer.example",
	})
	if !errors.Is(err, ErrIssuerMismatch) {
		t.Fatalf("want ErrIssuerMismatch, got %v", err)
	}
}

func TestValidate_IssUnpinnedIsAdvisory(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["iss"] = "https://issuer.example"
	tok := issueTestToken(t, p)

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1",
		NowSec:      now,
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.Iss == nil || *res.Iss != "https://issuer.example" {
		t.Fatalf("iss not surfaced when unpinned: %v", res.Iss)
	}
}

func TestValidate_IssWrongTypeIsRejected(t *testing.T) {
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["iss"] = int64(42)
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	var ce *ClientError
	if !errors.As(err, &ce) || ce.Code != CodeInvalidTokenFormat {
		t.Fatalf("want InvalidTokenFormat, got %v", err)
	}
}

func TestValidate_AudCheckBeforeIssCheck(t *testing.T) {
	// Both pins mismatch; aud should fire first per validation step 6 → 7.
	now := int64(1700000000)
	reg, bindings, keys := verifyDeps(t)
	p := basePayload(now)
	p["aud"] = "app-x"
	p["iss"] = "https://attacker.example"
	tok := issueTestToken(t, p)

	_, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint:      "fp-1",
		NowSec:           now,
		ExpectedAudience: "app-a",
		ExpectedIssuer:   "https://issuer.example",
	})
	if !errors.Is(err, ErrAudienceMismatch) {
		t.Fatalf("want ErrAudienceMismatch (fires before iss), got %v", err)
	}
}

func TestValidate_AudAndIssNilWhenAbsent(t *testing.T) {
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
	if res.Aud != nil {
		t.Fatalf("aud should be nil when absent: %+v", res.Aud)
	}
	if res.Iss != nil {
		t.Fatalf("iss should be nil when absent: %v", res.Iss)
	}
}
