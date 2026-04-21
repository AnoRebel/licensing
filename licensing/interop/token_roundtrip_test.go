package interop

import (
	"encoding/json"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

// isDeterministicAlg reports whether signatures produced by `alg` are a
// pure function of (key, message). Ed25519 and HMAC are deterministic —
// sign the same bytes twice and you get the same signature, so a fixture's
// expected_token.txt can be asserted byte-for-byte. RSA-PSS mixes fresh
// randomness into every signature, so only cross-verification (not byte
// equality) is meaningful.
func isDeterministicAlg(alg string) bool {
	return alg == "ed25519" || alg == "hs256"
}

// headerPayloadPrefix returns the "LIC1.<header_b64>.<payload_b64>" prefix
// — everything up to (but not including) the signature segment. For
// deterministic algs this is byte-equal to the rest of the token; for
// probabilistic algs (RSA-PSS) it's the only meaningful byte-level check.
func headerPayloadPrefix(token string) string {
	// token is "LIC1.<h>.<p>.<s>" — chop at the last '.'
	idx := strings.LastIndexByte(token, '.')
	if idx < 0 {
		return token
	}
	return token[:idx]
}

// TestTokenRoundTrip_TSSign_GoVerify proves that every fixture, re-signed by
// the TypeScript implementation, produces a LIC1 token the Go verifier
// accepts. This catches divergence in either canonical-JSON ordering,
// base64url alphabet, or signature envelope bytes.
func TestTokenRoundTrip_TSSign_GoVerify(t *testing.T) {
	requireBun(t)
	for _, v := range loadFixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			t.Parallel()
			// 1. TS signs.
			res, err := runBunCLI(t, "sign.ts", map[string]any{
				"alg":     v.Inputs.Alg,
				"key_ref": v.Inputs.KeyRef,
				"kid":     v.Inputs.Kid,
				"header":  v.Inputs.Header,
				"payload": v.Inputs.Payload,
			})
			if err != nil {
				t.Fatalf("ts sign: %v", err)
			}
			var signed struct {
				Token string `json:"token"`
			}
			if err := json.Unmarshal(res, &signed); err != nil {
				t.Fatalf("decode sign result: %v", err)
			}
			if !strings.HasPrefix(signed.Token, "LIC1.") {
				t.Fatalf("unexpected token prefix: %q", signed.Token[:min(8, len(signed.Token))])
			}

			// 2. For deterministic algs the TS-signed token MUST byte-equal
			//    the fixture — fixtures are the shared contract and any
			//    drift means canonical-json / base64 / envelope divergence.
			//    For RSA-PSS (probabilistic), only the header+payload
			//    prefix can be compared; the signature segment is fresh
			//    randomness each run. Cross-verification below is the
			//    authoritative parity check for RSA.
			if isDeterministicAlg(v.Inputs.Alg) {
				if signed.Token != v.Token {
					t.Errorf("TS-signed token != fixture expected_token\n  got:  %s\n  want: %s", signed.Token, v.Token)
				}
			} else {
				gotPrefix := headerPayloadPrefix(signed.Token)
				wantPrefix := headerPayloadPrefix(v.Token)
				if gotPrefix != wantPrefix {
					t.Errorf("TS-signed prefix != fixture prefix (RSA-PSS sig differs by design, but header+payload must match)\n  got:  %s\n  want: %s", gotPrefix, wantPrefix)
				}
			}

			// 3. Go verifies the TS-signed token.
			rec := loadKeyRecord(t, v.Inputs.KeyRef, v.Inputs.Kid, lic.KeyAlg(v.Inputs.Alg))
			reg, bindings, keys := verifyRegistry(t, rec)
			parts, err := lic.Verify(signed.Token, lic.VerifyOptions{
				Registry: reg,
				Bindings: bindings,
				Keys:     keys,
			})
			if err != nil {
				t.Fatalf("go verify rejected TS token: %v", err)
			}
			if parts.Header.Kid != v.Inputs.Kid {
				t.Errorf("kid mismatch: got %q want %q", parts.Header.Kid, v.Inputs.Kid)
			}
			if string(parts.Header.Alg) != v.Inputs.Alg {
				t.Errorf("alg mismatch: got %q want %q", parts.Header.Alg, v.Inputs.Alg)
			}
		})
	}
}

// TestTokenRoundTrip_GoSign_TSVerify closes the loop: the Go side encodes a
// fresh token from the fixture inputs, hands it to TS, and TS accepts it.
// Uses lic.Encode (not fixture bytes) so we're exercising the Go signing
// path, not re-verifying a byte we already saw.
func TestTokenRoundTrip_GoSign_TSVerify(t *testing.T) {
	requireBun(t)
	for _, v := range loadFixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			t.Parallel()
			rec := loadKeyRecord(t, v.Inputs.KeyRef, v.Inputs.Kid, lic.KeyAlg(v.Inputs.Alg))
			reg, _, _ := verifyRegistry(t, rec)
			backend, err := reg.Get(lic.KeyAlg(v.Inputs.Alg))
			if err != nil {
				t.Fatalf("registry get: %v", err)
			}
			priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw}, "")
			if err != nil {
				t.Fatalf("import private: %v", err)
			}

			// Build a minimal LIC1Header from the fixture's header fields —
			// lic.Encode enforces the strict 4-field shape so we don't need
			// to pass through the raw map.
			header := lic.LIC1Header{
				V:   1,
				Typ: "lic",
				Alg: lic.KeyAlg(v.Inputs.Alg),
				Kid: v.Inputs.Kid,
			}
			token, err := lic.Encode(lic.EncodeOptions{
				Header:     header,
				Payload:    v.Inputs.Payload,
				PrivateKey: priv,
				Backend:    backend,
			})
			if err != nil {
				t.Fatalf("go sign: %v", err)
			}

			// Byte-equality check only for deterministic algs; see comment
			// in TestTokenRoundTrip_TSSign_GoVerify.
			if isDeterministicAlg(v.Inputs.Alg) {
				if token != v.Token {
					t.Errorf("Go-signed token != fixture expected_token\n  got:  %s\n  want: %s", token, v.Token)
				}
			} else {
				gotPrefix := headerPayloadPrefix(token)
				wantPrefix := headerPayloadPrefix(v.Token)
				if gotPrefix != wantPrefix {
					t.Errorf("Go-signed prefix != fixture prefix (RSA-PSS sig differs by design)\n  got:  %s\n  want: %s", gotPrefix, wantPrefix)
				}
			}

			// TS verifies the Go-signed token.
			_, err = runBunCLI(t, "verify.ts", map[string]any{
				"token":   token,
				"alg":     v.Inputs.Alg,
				"key_ref": v.Inputs.KeyRef,
				"kid":     v.Inputs.Kid,
			})
			if err != nil {
				t.Fatalf("ts verify rejected Go token: %v", err)
			}
		})
	}
}
