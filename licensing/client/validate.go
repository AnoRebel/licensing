package client

import (
	"encoding/json"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ValidateOptions configures offline token validation.
type ValidateOptions struct {
	Registry *lic.AlgorithmRegistry
	Bindings *lic.KeyAlgBindings
	Keys     map[string]lic.KeyRecord
	// JtiLedger, when non-nil, gates each token by jti — a token whose
	// jti was previously recorded surfaces as
	// *ClientError{Code: CodeTokenReplayed}. Meaningful only for online
	// verifiers; offline clients can't share state and should leave
	// this nil. The ledger entry is recorded AFTER all other validate
	// checks pass, so a malformed/expired/wrong-fingerprint token
	// doesn't burn an entry it would have been rejected for anyway.
	JtiLedger JtiLedger
	// ExpectedAudience, when non-empty, pins the audience the token
	// MUST be issued for. The token's `aud` claim — string or array —
	// MUST contain this value. Mismatches surface as
	// CodeAudienceMismatch. Empty means the audience is unpinned and
	// the claim is advisory.
	ExpectedAudience string
	// ExpectedIssuer, when non-empty, pins the issuer the token MUST
	// have been signed by. The token's `iss` claim MUST equal this
	// value. Mismatches surface as CodeIssuerMismatch. Empty means
	// the issuer is unpinned and the claim is advisory.
	ExpectedIssuer string
	Fingerprint    string
	NowSec         int64
	SkewSec        int64 // default 60
}

func (o ValidateOptions) skew() int64 {
	if o.SkewSec > 0 {
		return o.SkewSec
	}
	return 60
}

// ValidateResult carries the decoded and verified claims.
type ValidateResult struct {
	Entitlements     map[string]any
	ForceOnlineAfter *int64
	Iss              *string
	LicenseID        string
	Kid              string
	Alg              lic.KeyAlg
	UsageID          string
	Scope            string
	Status           string
	Aud              []string
	MaxUsages        int64
	Iat              int64
	Nbf              int64
	Exp              int64
}

// PeekResult carries the cheaply-decoded lifetime claims (no sig check).
type PeekResult struct {
	ForceOnlineAfter *int64
	Kid              string
	Alg              lic.KeyAlg
	Iat              int64
	Nbf              int64
	Exp              int64
}

// Validate performs full offline validation of a LIC1 token.
// Check order: (1) parse + sig verify, (2) nbf/exp with skew,
// (3) status in {active, grace}, (4) force_online_after hard deadline,
// (5) fingerprint match.
func Validate(token string, opts ValidateOptions) (*ValidateResult, error) {
	// 1. Parse + signature verify.
	parts, err := lic.Verify(token, lic.VerifyOptions{
		Registry: opts.Registry,
		Bindings: opts.Bindings,
		Keys:     opts.Keys,
	})
	if err != nil {
		return nil, TranslateVerifyError(err)
	}

	// Extract and validate required claims.
	claims, err := assertClaimShape(parts.Payload)
	if err != nil {
		return nil, err
	}

	skew := opts.skew()

	// 2. Not-before / expiry with skew. Uses strict inequality on both
	//    sides per LIC1 spec ("exp < now - skew" → expired; "nbf > now +
	//    skew" → not yet valid) — matches the TS client and keeps the
	//    boundary inclusive of the stated deadline.
	if claims.Nbf > opts.NowSec+skew {
		return nil, TokenNotYetValid(
			fmt.Sprintf("token not valid until %d (now=%d, skew=%d)", claims.Nbf, opts.NowSec, skew))
	}
	if claims.Exp+skew < opts.NowSec {
		return nil, TokenExpired(
			fmt.Sprintf("token expired at %d (now=%d, skew=%d)", claims.Exp, opts.NowSec, skew))
	}

	// 3. Status check.
	switch claims.Status {
	case "active", "grace":
		// OK
	case "revoked":
		return nil, LicenseRevoked("")
	case "suspended":
		return nil, LicenseSuspended("")
	case "expired":
		return nil, TokenExpired("token status is expired")
	default:
		return nil, InvalidTokenFormat(
			fmt.Sprintf("unexpected token status: %s", claims.Status), nil)
	}

	// 4. force_online_after hard deadline (no skew).
	if claims.ForceOnlineAfter != nil && opts.NowSec >= *claims.ForceOnlineAfter {
		return nil, RequiresOnlineRefresh(
			fmt.Sprintf("force_online_after %d has passed (now=%d)",
				*claims.ForceOnlineAfter, opts.NowSec))
	}

	// 5. Fingerprint match.
	if claims.UsageFingerprint != opts.Fingerprint {
		return nil, FingerprintMismatch(
			fmt.Sprintf("token fingerprint %q does not match %q",
				claims.UsageFingerprint, opts.Fingerprint))
	}

	// 6. Audience pin (optional). When the verifier supplies
	//    ExpectedAudience, the token's `aud` MUST contain it. A token
	//    without an `aud` claim fails the pin (the absence is itself
	//    a mismatch in a multi-audience deployment).
	if opts.ExpectedAudience != "" {
		if !audContains(claims.Aud, opts.ExpectedAudience) {
			return nil, AudienceMismatch(
				fmt.Sprintf("expected aud=%s, token has %s",
					opts.ExpectedAudience, audDescription(claims.Aud)))
		}
	}

	// 7. Issuer pin (optional). When the verifier supplies
	//    ExpectedIssuer, the token's `iss` MUST equal it. Tokens
	//    without an `iss` claim fail the pin for the same reason.
	if opts.ExpectedIssuer != "" {
		actual := ""
		if claims.Iss != nil {
			actual = *claims.Iss
		}
		if actual != opts.ExpectedIssuer {
			label := "no iss"
			if claims.Iss != nil {
				label = "iss=" + *claims.Iss
			}
			return nil, IssuerMismatch(
				fmt.Sprintf("expected iss=%s, token has %s",
					opts.ExpectedIssuer, label))
		}
	}

	// 8. Replay-prevention ledger (optional). Records this jti's use
	//    AFTER all other checks have passed so an expired / wrong-
	//    fingerprint / etc. token doesn't burn a ledger entry it would
	//    have been rejected for anyway. Second use of the same jti
	//    surfaces as CodeTokenReplayed.
	if opts.JtiLedger != nil {
		firstUse, err := opts.JtiLedger.RecordJtiUse(claims.Jti, claims.Exp+skew)
		if err != nil {
			return nil, fmt.Errorf("jti ledger: %w", err)
		}
		if !firstUse {
			return nil, TokenReplayed(
				fmt.Sprintf("jti %s was previously recorded by this verifier", claims.Jti))
		}
	}

	return &ValidateResult{
		Kid:              parts.Header.Kid,
		Alg:              parts.Header.Alg,
		LicenseID:        claims.LicenseID,
		UsageID:          claims.UsageID,
		Scope:            claims.Scope,
		Status:           claims.Status,
		MaxUsages:        claims.MaxUsages,
		Iat:              claims.Iat,
		Nbf:              claims.Nbf,
		Exp:              claims.Exp,
		ForceOnlineAfter: claims.ForceOnlineAfter,
		Entitlements:     claims.Entitlements,
		Aud:              claims.Aud,
		Iss:              claims.Iss,
	}, nil
}

// audContains reports whether aud (which may be nil) contains target.
func audContains(aud []string, target string) bool {
	for _, a := range aud {
		if a == target {
			return true
		}
	}
	return false
}

// audDescription is a compact human-readable summary for mismatch
// error messages — avoids emitting a giant audience array into a log.
func audDescription(aud []string) string {
	if aud == nil {
		return "no aud"
	}
	if len(aud) == 1 {
		return "aud=" + aud[0]
	}
	return fmt.Sprintf("aud=[%d values]", len(aud))
}

// Peek performs a synchronous, unverified decode of a LIC1 token. Returns
// the header and lifetime claims. Used by Refresh to cheaply decide if a
// refresh is due without paying the crypto cost.
func Peek(token string) (*PeekResult, error) {
	parts, err := lic.DecodeUnverified(token)
	if err != nil {
		return nil, TranslateVerifyError(err)
	}
	iat, _ := claimInt64(parts.Payload, "iat")
	nbf, _ := claimInt64(parts.Payload, "nbf")
	exp, _ := claimInt64(parts.Payload, "exp")
	foa := claimOptInt64(parts.Payload, "force_online_after")

	return &PeekResult{
		Kid:              parts.Header.Kid,
		Alg:              parts.Header.Alg,
		Iat:              iat,
		Nbf:              nbf,
		Exp:              exp,
		ForceOnlineAfter: foa,
	}, nil
}

// ---------- claim extraction ----------

type requiredClaims struct {
	Entitlements     map[string]any
	ForceOnlineAfter *int64
	Iss              *string
	LicenseID        string
	Jti              string
	Scope            string
	UsageID          string
	UsageFingerprint string
	Status           string
	Aud              []string
	Iat              int64
	Nbf              int64
	Exp              int64
	MaxUsages        int64
}

func assertClaimShape(p lic.LIC1Payload) (*requiredClaims, error) {
	c := &requiredClaims{}
	var ok bool

	c.Jti, ok = claimString(p, "jti")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: jti", nil)
	}
	c.Iat, ok = claimInt64(p, "iat")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: iat", nil)
	}
	c.Nbf, ok = claimInt64(p, "nbf")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: nbf", nil)
	}
	c.Exp, ok = claimInt64(p, "exp")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: exp", nil)
	}
	c.Scope, ok = claimString(p, "scope")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: scope", nil)
	}
	c.LicenseID, ok = claimString(p, "license_id")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: license_id", nil)
	}
	c.UsageID, ok = claimString(p, "usage_id")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: usage_id", nil)
	}
	c.UsageFingerprint, ok = claimString(p, "usage_fingerprint")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: usage_fingerprint", nil)
	}
	c.Status, ok = claimString(p, "status")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: status", nil)
	}
	c.MaxUsages, ok = claimInt64(p, "max_usages")
	if !ok {
		return nil, InvalidTokenFormat("missing or invalid claim: max_usages", nil)
	}

	// Optional claims.
	c.ForceOnlineAfter = claimOptInt64(p, "force_online_after")
	if ents, exists := p["entitlements"]; exists && ents != nil {
		if m, ok := ents.(map[string]any); ok {
			c.Entitlements = m
		}
	}

	// Optional audience: string OR array-of-strings. Wrong types are
	// hard-rejected so a malformed token can't degrade silently to
	// "advisory ignored" mode.
	if aud, exists := p["aud"]; exists && aud != nil {
		switch v := aud.(type) {
		case string:
			c.Aud = []string{v}
		case []any:
			out := make([]string, 0, len(v))
			for _, item := range v {
				s, ok := item.(string)
				if !ok {
					return nil, InvalidTokenFormat("aud array must contain only strings", nil)
				}
				out = append(out, s)
			}
			c.Aud = out
		default:
			return nil, InvalidTokenFormat("aud must be a string or array of strings", nil)
		}
	}

	// Optional issuer: string only.
	if iss, exists := p["iss"]; exists && iss != nil {
		s, ok := iss.(string)
		if !ok {
			return nil, InvalidTokenFormat("iss must be a string", nil)
		}
		c.Iss = &s
	}

	return c, nil
}

func claimString(p lic.LIC1Payload, key string) (string, bool) {
	v, ok := p[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func claimInt64(p lic.LIC1Payload, key string) (int64, bool) {
	v, ok := p[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case json.Number:
		i, err := x.Int64()
		return i, err == nil
	case float64:
		return int64(x), x == float64(int64(x))
	case int64:
		return x, true
	case int:
		return int64(x), true
	default:
		return 0, false
	}
}

func claimOptInt64(p lic.LIC1Payload, key string) *int64 {
	v, ok := claimInt64(p, key)
	if !ok {
		return nil
	}
	return &v
}
