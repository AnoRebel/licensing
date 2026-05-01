package licensing

import (
	"errors"
	"strings"
	"testing"
)

// Strict duplicate-key parser tests.
//
// The canonical-JSON encoder has always rejected duplicate keys, but the
// parser used during verification was previously a vanilla json.Unmarshal
// that silently last-wins on duplicates. A tampered token containing
// e.g. {"status":"revoked","status":"active"} would deserialize as
// status=active. The signature is over the canonical issuer-produced
// bytes (which can't have duplicates), so this was not exploitable in
// practice — but the defence-in-depth fix is to reject the duplicate at
// parse time, before the signature is verified.
//
// These tests prove the rejection happens with the right error code on
// every shape an attacker might try.

func TestParseJSONObject_RejectsDuplicateKeyInPayload(t *testing.T) {
	// Hand-crafted bytes — Go map literals can't carry duplicates.
	raw := []byte(`{"a":1,"a":2}`)
	_, err := parseJSONObject(raw, "payload")
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeCanonicalJSONDuplicateKey {
		t.Fatalf("want CanonicalJSONDuplicateKey, got %v", err)
	}
	if !strings.Contains(le.Message, "duplicate key: a") {
		t.Fatalf("error message should name the offending key: %q", le.Message)
	}
}

func TestParseJSONObject_RejectsDuplicateKeyInHeader(t *testing.T) {
	raw := []byte(`{"v":1,"alg":"ed25519","alg":"hs256","kid":"k","typ":"lic"}`)
	_, err := parseJSONObject(raw, "header")
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeCanonicalJSONDuplicateKey {
		t.Fatalf("want CanonicalJSONDuplicateKey, got %v", err)
	}
	// The duplicated key is alg, not v — message must reflect that so the
	// detection is precise (otherwise we'd be hiding which claim was
	// shadowed).
	if !strings.Contains(le.Message, "duplicate key: alg") {
		t.Fatalf("error message should name the offending key: %q", le.Message)
	}
}

func TestParseJSONObject_RejectsDuplicateKeyInNestedObject(t *testing.T) {
	// Duplicate nested under entitlements — the verifier traverses freely
	// into nested maps so the rejection MUST recurse.
	raw := []byte(`{"jti":"x","entitlements":{"tier":"pro","tier":"free"}}`)
	_, err := parseJSONObject(raw, "payload")
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeCanonicalJSONDuplicateKey {
		t.Fatalf("want CanonicalJSONDuplicateKey, got %v", err)
	}
	if !strings.Contains(le.Message, "duplicate key: tier") {
		t.Fatalf("nested duplicate must be named: %q", le.Message)
	}
}

func TestParseJSONObject_RejectsDuplicateKeyInsideArrayObject(t *testing.T) {
	// Object inside an array also walks through the strict path.
	raw := []byte(`{"items":[{"k":1,"k":2}]}`)
	_, err := parseJSONObject(raw, "payload")
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeCanonicalJSONDuplicateKey {
		t.Fatalf("want CanonicalJSONDuplicateKey, got %v", err)
	}
}

func TestParseJSONObject_AcceptsRepeatedValuesAtDifferentKeys(t *testing.T) {
	// Two distinct keys carrying the same VALUE is not a duplicate; only
	// duplicate KEY names are rejected.
	raw := []byte(`{"a":"same","b":"same"}`)
	obj, err := parseJSONObject(raw, "payload")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(obj) != 2 || obj["a"] != "same" || obj["b"] != "same" {
		t.Fatalf("repeated values at different keys must round-trip: %+v", obj)
	}
}

func TestParseJSONObject_AcceptsSameKeyInSiblingScopes(t *testing.T) {
	// "x" appears in two sibling sub-objects — perfectly valid because
	// each sub-object has its own scope. The duplicate guard MUST be
	// scope-local, not global.
	raw := []byte(`{"a":{"x":1},"b":{"x":2}}`)
	obj, err := parseJSONObject(raw, "payload")
	if err != nil {
		t.Fatalf("sibling scopes with same-named keys must parse: %v", err)
	}
	if len(obj) != 2 {
		t.Fatalf("expected 2 top-level keys, got %d", len(obj))
	}
}

// TestVerify_RejectsDuplicateKeyTokenBeforeSigCheck proves the rejection
// happens at parse time, before the cryptographic verification step.
// This is what makes the fix defence-in-depth: even if an attacker
// somehow produced a valid signature over duplicate-key bytes, the parser
// stops the token before the signature is checked.
func TestVerify_RejectsDuplicateKeyTokenBeforeSigCheck(t *testing.T) {
	// Hand-build a wire token with a duplicate-key payload. We don't sign
	// it correctly — the test asserts that the parser fails BEFORE the
	// signature check, which would fail with TokenSignatureInvalid if the
	// parser ran first. With the strict parser, the response must be
	// CanonicalJSONDuplicateKey instead.
	header := `{"v":1,"typ":"lic","alg":"ed25519","kid":"x"}`
	payload := `{"jti":"a","jti":"b"}`
	headerB64 := Base64urlEncode([]byte(header))
	payloadB64 := Base64urlEncode([]byte(payload))
	// Sig is junk; the test asserts we never reach signature verification.
	sigB64 := Base64urlEncode([]byte("not-a-real-signature"))
	token := "LIC1." + headerB64 + "." + payloadB64 + "." + sigB64

	_, err := DecodeUnverified(token)
	var le *Error
	if !errors.As(err, &le) {
		t.Fatalf("expected *Error, got %T %v", err, err)
	}
	if le.Code != CodeCanonicalJSONDuplicateKey {
		t.Fatalf("strict parser must surface CanonicalJSONDuplicateKey; got %s (msg=%s)",
			le.Code, le.Message)
	}
}
