package middleware_test

import (
	"encoding/json"
	"testing"

	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/middleware"
)

// TestCrossPortParity_JSONBodyShape pins the wire JSON shape produced
// by BuildGuardError so it matches the TypeScript port's GuardErrorBody
// (typescript/src/middleware/core.ts).
//
// Both ports MUST emit:
//
//	{"error": "<ClientErrorCode>", "message": "<human-readable>"}
//
// Field names are lowercase (Go's json tag and TS's plain object key
// happen to align). No extra fields. No nested envelope. A future field
// addition needs to land in both ports simultaneously — this test
// catches Go-side drift.
func TestCrossPortParity_JSONBodyShape(t *testing.T) {
	err := &client.ClientError{
		Code:    client.CodeFingerprintMismatch,
		Message: "token fingerprint does not match this device",
	}
	_, body := middleware.BuildGuardError(err)

	encoded, jerr := json.Marshal(body)
	if jerr != nil {
		t.Fatalf("marshal: %v", jerr)
	}
	want := `{"error":"FingerprintMismatch","message":"token fingerprint does not match this device"}`
	if string(encoded) != want {
		t.Fatalf("body shape drift:\n  got  %s\n  want %s", encoded, want)
	}
}

// TestCrossPortParity_MissingFingerprintShape pins the synthetic
// "MissingFingerprint" case, which is NOT a ClientErrorCode but is
// emitted by RunGuard when the extractor fails. Both ports use the
// same code+message so logs aggregate cleanly across language
// boundaries.
func TestCrossPortParity_MissingFingerprintShape(t *testing.T) {
	// We can't directly call missingFingerprintResult (unexported), but
	// the body shape is identical to BuildGuardError's. Verify the
	// JSON marshalling pins the field names.
	body := middleware.GuardErrorBody{
		Error:   "MissingFingerprint",
		Message: "fingerprint extractor returned no value",
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"error":"MissingFingerprint","message":"fingerprint extractor returned no value"}`
	if string(encoded) != want {
		t.Fatalf("missing-fingerprint shape drift:\n  got  %s\n  want %s", encoded, want)
	}
}
