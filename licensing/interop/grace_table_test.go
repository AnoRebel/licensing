package interop

import (
	"encoding/json"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/client"
)

// TestGracePeriodTable_TSvsGo proves the two client validators agree on
// classification codes across the LIC1 lifecycle transition table.
//
// For each row we:
//  1. Build a LIC1 token whose payload reflects the row's claims (status,
//     nbf, exp, force_online_after, fingerprint)
//  2. Run Go's client.Validate at the row's `now` — capture code string
//     ("Ok" or ClientErrorCode)
//  3. Shell out to TS's validate() via classify.ts for the identical tuple
//  4. Assert both codes equal the row's `want`
//
// The fixture key for ed25519 is reused — signature verification is not the
// concern here; lifecycle classification is. A single alg is enough because
// the classifier is alg-agnostic by design.
func TestGracePeriodTable_TSvsGo(t *testing.T) {
	requireBun(t)

	const fingerprint = "fp-grace-table-0000000000000000000000000000000000000000000000000000"
	const kid = "fixture-ed25519-1"
	const keyRef = "ed25519"
	const alg = "ed25519"

	// Build the Go signer once; every row reuses it.
	rec := loadKeyRecord(t, keyRef, kid, lic.AlgEd25519)
	reg, bindings, keys := verifyRegistry(t, rec)
	backend, err := reg.Get(lic.AlgEd25519)
	if err != nil {
		t.Fatalf("registry get: %v", err)
	}
	priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw}, "")
	if err != nil {
		t.Fatalf("import private: %v", err)
	}

	// Anchor clock: nbf/iat=1_700_000_000, exp=1_800_000_000 (~three years).
	// Table rows then probe specific "now" values relative to this anchor.
	const nbf = int64(1_700_000_000)
	const exp = int64(1_800_000_000)

	type row struct {
		forceOnlineAfter *int64
		name             string
		status           string
		fingerprint      string
		want             string
		nowSec           int64
		skewSec          int64
	}

	// Helpers for pointer literals in the table.
	ptr := func(v int64) *int64 { return &v }

	rows := []row{
		{name: "active_before_nbf_within_skew", status: "active", nowSec: nbf - 30, want: "Ok"},
		{name: "active_before_nbf_outside_skew", status: "active", nowSec: nbf - 120, want: "TokenNotYetValid"},
		{name: "active_exactly_exp_minus_skew", status: "active", nowSec: exp - 60, want: "Ok"},
		{name: "active_at_exp_within_skew", status: "active", nowSec: exp, want: "Ok"},
		{name: "active_past_exp_plus_skew", status: "active", nowSec: exp + 61, want: "TokenExpired"},
		{name: "active_after_exp_within_skew", status: "active", nowSec: exp - 30, want: "Ok"},
		{name: "active_after_exp_outside_skew", status: "active", nowSec: exp + 3600, want: "TokenExpired"},

		{name: "grace_midlife", status: "grace", nowSec: nbf + 1_000_000, want: "Ok"},
		{name: "suspended_midlife", status: "suspended", nowSec: nbf + 1_000_000, want: "LicenseSuspended"},
		{name: "revoked_midlife", status: "revoked", nowSec: nbf + 1_000_000, want: "LicenseRevoked"},

		{name: "foa_unset_midlife", status: "active", forceOnlineAfter: nil, nowSec: nbf + 1_000_000, want: "Ok"},
		{name: "foa_future_ok", status: "active", forceOnlineAfter: ptr(nbf + 2_000_000), nowSec: nbf + 1_000_000, want: "Ok"},
		{name: "foa_reached_exactly", status: "active", forceOnlineAfter: ptr(nbf + 1_000_000), nowSec: nbf + 1_000_000, want: "RequiresOnlineRefresh"},
		{name: "foa_past", status: "active", forceOnlineAfter: ptr(nbf + 500_000), nowSec: nbf + 1_000_000, want: "RequiresOnlineRefresh"},

		{name: "fingerprint_mismatch", status: "active", fingerprint: "different-fp-padding-to-64-chars-000000000000000000000000000000", nowSec: nbf + 1_000_000, want: "FingerprintMismatch"},

		{name: "status_expired_string", status: "expired", nowSec: nbf + 1_000_000, want: "TokenExpired"},
	}

	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			t.Parallel()

			// ---- build the token ----
			usageFp := fingerprint
			if r.fingerprint != "" {
				usageFp = r.fingerprint
			}
			payload := map[string]any{
				"jti":               "grace-" + r.name,
				"iat":               nbf,
				"nbf":               nbf,
				"exp":               exp,
				"scope":             "example.app",
				"license_id":        "00000000-0000-4000-8000-000000000001",
				"usage_id":          "00000000-0000-4000-8000-000000000002",
				"usage_fingerprint": usageFp,
				"status":            r.status,
				"max_usages":        int64(5),
				"meta":              map[string]any{},
				"entitlements":      map[string]any{},
			}
			if r.forceOnlineAfter != nil {
				payload["force_online_after"] = *r.forceOnlineAfter
			} else {
				// Canonical "unset" for force_online_after is explicit
				// null — that's what the fixtures ship and what Go's
				// claimOptInt64 treats as absent. TS client now accepts
				// null as equivalent to missing (was: threw
				// invalid-token-format), bringing both classifiers to
				// the same contract.
				payload["force_online_after"] = nil
			}

			token, err := lic.Encode(lic.EncodeOptions{
				Header: lic.LIC1Header{
					V:   1,
					Typ: "lic",
					Alg: lic.AlgEd25519,
					Kid: kid,
				},
				Payload:    payload,
				PrivateKey: priv,
				Backend:    backend,
			})
			if err != nil {
				t.Fatalf("go encode: %v", err)
			}

			// ---- Go classifies ----
			goOpts := client.ValidateOptions{
				Registry:    reg,
				Bindings:    bindings,
				Keys:        keys,
				Fingerprint: fingerprint,
				NowSec:      r.nowSec,
				SkewSec:     r.skewSec,
			}
			goCode := classifyGo(client.Validate(token, goOpts))
			if goCode != r.want {
				t.Errorf("go classify: got %q, want %q", goCode, r.want)
			}

			// ---- TS classifies ----
			tsReq := map[string]any{
				"token":       token,
				"alg":         alg,
				"key_ref":     keyRef,
				"kid":         kid,
				"fingerprint": fingerprint,
				"now_sec":     r.nowSec,
			}
			if r.skewSec > 0 {
				tsReq["skew_sec"] = r.skewSec
			}
			raw, err := runBunCLI(t, "classify.ts", tsReq)
			if err != nil {
				t.Fatalf("ts classify: %v", err)
			}
			var tsRes struct {
				Code   string `json:"code"`
				Detail string `json:"detail"`
			}
			if err := json.Unmarshal(raw, &tsRes); err != nil {
				t.Fatalf("decode ts classify: %v", err)
			}
			if tsRes.Code != r.want {
				t.Errorf("ts classify: got %q (detail=%q), want %q", tsRes.Code, tsRes.Detail, r.want)
			}
			if goCode != tsRes.Code {
				t.Errorf("divergence: go=%q ts=%q (want=%q, detail=%q)", goCode, tsRes.Code, r.want, tsRes.Detail)
			}
		})
	}
}

// classifyGo extracts the short code string from a Go client.Validate result.
// "Ok" for success; otherwise the ClientError.Code verbatim. Unexpected
// errors (wrong type) bubble up as "UnknownError" so the mismatch is visible
// instead of crashing.
func classifyGo(_ *client.ValidateResult, err error) string {
	if err == nil {
		return "Ok"
	}
	var ce *client.ClientError
	if errorsAs(err, &ce) {
		return string(ce.Code)
	}
	return "UnknownError"
}

// errorsAs is a tiny shim around errors.As that avoids importing the
// standard errors package at the top of the file solely for this one use.
func errorsAs(err error, target **client.ClientError) bool {
	if err == nil {
		return false
	}
	for e := err; e != nil; {
		if ce, ok := e.(*client.ClientError); ok {
			*target = ce
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := e.(unwrapper)
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
