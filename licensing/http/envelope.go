package http

import (
	"encoding/json"
	"errors"
	"net/http"

	lic "github.com/AnoRebel/licensing/licensing"
)

// Envelope is the wire shape for every response. Exactly one of Data or Error
// is populated per the Success flag. Clients rely on this invariant.
type Envelope struct {
	Data    any           `json:"data,omitempty"`
	Error   *ErrorDetails `json:"error,omitempty"`
	Success bool          `json:"success"`
}

// ErrorDetails carries a stable code and human message.
type ErrorDetails struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeOK writes a 200 success envelope.
func writeOK(w http.ResponseWriter, data any) {
	writeOKStatus(w, http.StatusOK, data)
}

// writeOKStatus writes a success envelope with an explicit status.
func writeOKStatus(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Envelope{Success: true, Data: data})
}

// writeNoContent writes a 204 with no body.
func writeNoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// writeError writes an error envelope with status, stable code, and message.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeErrorWithHeaders(w, status, code, message, nil)
}

// writeErrorWithHeaders is writeError with additional headers (e.g. Retry-After).
func writeErrorWithHeaders(w http.ResponseWriter, status int, code, message string, extra map[string]string) {
	for k, v := range extra {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Envelope{
		Success: false,
		Error:   &ErrorDetails{Code: code, Message: message},
	})
}

// errorStatus maps core licensing error codes to canonical HTTP statuses.
// Mirrors the TS ERROR_STATUS table; unknown codes default to 500.
var errorStatus = map[lic.ErrorCode]int{
	// 400 — malformed input / canonical JSON failures
	lic.CodeCanonicalJSONInvalidType:     400,
	lic.CodeCanonicalJSONInvalidNumber:   400,
	lic.CodeCanonicalJSONInvalidUTF8:     400,
	lic.CodeCanonicalJSONInvalidTopLevel: 400,
	lic.CodeCanonicalJSONDuplicateKey:    400,
	lic.CodeCanonicalJSONUnknownField:    400,
	lic.CodeTokenMalformed:               400,
	lic.CodeUnsupportedTokenFormat:       400,
	lic.CodeInvalidLicenseKey:            404,
	// 401 — auth
	lic.CodeUnauthenticated:       401,
	lic.CodeTokenSignatureInvalid: 401,
	lic.CodeTokenExpired:          401,
	lic.CodeTokenNotYetValid:      401,
	// 403 — policy/lifecycle block
	lic.CodeFingerprintRejected: 403,
	lic.CodeLicenseSuspended:    403,
	lic.CodeLicenseRevoked:      403,
	lic.CodeLicenseExpired:      403,
	lic.CodeGraceExpired:        403,
	// 404 — not found
	lic.CodeLicenseNotFound: 404,
	lic.CodeUnknownKid:      404,
	// 409 — conflicts
	lic.CodeLicenseKeyConflict:         409,
	lic.CodeUniqueConstraintViolation:  409,
	lic.CodeSeatLimitExceeded:          409,
	lic.CodeIllegalLifecycleTransition: 409,
	lic.CodeTemplateCycle:              409,
	// 422 — crypto preconditions
	lic.CodeUnsupportedAlgorithm:       422,
	lic.CodeAlgorithmAlreadyRegistered: 422,
	lic.CodeAlgorithmMismatch:          422,
	lic.CodeInsufficientKeyStrength:    422,
	lic.CodeMissingKeyPassphrase:       422,
	lic.CodeKeyDecryptionFailed:        422,
	// 429 — rate limit
	lic.CodeRateLimited: 429,
	// 500 — write-side invariants that shouldn't escape but typed for completeness
	lic.CodeImmutableAuditLog: 500,
}

// writeErrorFromLicensing maps a *lic.Error to its canonical HTTP response.
// Non-licensing errors become a generic opaque 500 to avoid leaking internals.
func writeErrorFromLicensing(w http.ResponseWriter, err error) {
	var le *lic.Error
	if errors.As(err, &le) {
		status, ok := errorStatus[le.Code]
		if !ok {
			status = 500
		}
		writeError(w, status, string(le.Code), le.Message)
		return
	}
	writeError(w, 500, "InternalError", "an unexpected error occurred")
}
