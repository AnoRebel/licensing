package client

import (
	"encoding/json"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ValidateOptions configures offline token validation.
type ValidateOptions struct {
	Registry    *lic.AlgorithmRegistry
	Bindings    *lic.KeyAlgBindings
	Keys        map[string]lic.KeyRecord
	Fingerprint string
	NowSec      int64
	SkewSec     int64 // default 60
}

func (o ValidateOptions) skew() int64 {
	if o.SkewSec > 0 {
		return o.SkewSec
	}
	return 60
}

// ValidateResult carries the decoded and verified claims.
type ValidateResult struct {
	ForceOnlineAfter *int64
	Entitlements     map[string]any
	Kid              string
	Alg              lic.KeyAlg
	LicenseID        string
	UsageID          string
	Scope            string
	Status           string
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
	}, nil
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
	ForceOnlineAfter *int64
	Entitlements     map[string]any
	Jti              string
	Scope            string
	LicenseID        string
	UsageID          string
	UsageFingerprint string
	Status           string
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
