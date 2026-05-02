// Package middleware contains the framework-agnostic license-guard core
// shared by the chi, gin, and echo adapters.
//
// Each adapter is a thin shim over RunGuard: extract a fingerprint from
// the framework's native request, call RunGuard, translate the result
// into the framework's native response shape. The status-code mapping
// and JSON body shape live HERE so all three adapters emit
// byte-identical responses for the same client error.
//
// The mapping mirrors the TypeScript port in
// typescript/src/middleware/core.ts so a deployment that splits servers
// across languages sees uniform HTTP semantics.
package middleware

import (
	"errors"

	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/easy"
)

// FingerprintExtractor pulls the device fingerprint string out of the
// framework's native request shape. Returning an empty string (or an
// error) surfaces as a 400 MissingFingerprint response.
//
// Generic over Req so each framework adapter can declare a typed
// extractor (e.g. *http.Request for chi, *gin.Context for gin) without
// the caller having to cast.
type FingerprintExtractor[Req any] func(req Req) (string, error)

// OnSuccessHook fires when the guard succeeds. Useful for logging or
// for populating framework-specific request context that the core
// doesn't know about. Returning an error short-circuits to a 500.
type OnSuccessHook[Req any] func(req Req, handle *easy.LicenseHandle) error

// GuardErrorBody is the wire shape returned on guard failure. Stable
// across every framework adapter — adding a field requires a contract
// test update.
type GuardErrorBody struct {
	// Error is the stable machine-readable code from
	// client.ClientError.Code, or "MissingFingerprint" /
	// "InternalError" for the two cases that don't originate from the
	// client.
	Error string `json:"error"`
	// Message is human-readable; suitable for logs, NOT for direct
	// display to end users without translation.
	Message string `json:"message"`
}

// GuardResult is the discriminated outcome of RunGuard. On success,
// Handle is non-nil and Status/Body are zero-valued. On failure,
// Handle is nil and Status/Body carry the canonical error response.
//
// Adapters MUST translate the failure case faithfully — same status,
// same body, same JSON encoding — so the cross-framework parity test
// holds.
type GuardResult struct {
	Handle *easy.LicenseHandle
	Body   GuardErrorBody
	Status int
	OK     bool
}

// LicenseGuardConfig is the shared configuration shape every adapter
// builds on top of. Each adapter wraps this with its own
// framework-typed FingerprintExtractor.
type LicenseGuardConfig struct {
	// Client is a pre-constructed *easy.Client (typically from
	// easy.NewClient). The middleware does NOT construct one because
	// that would force a particular storage decision.
	Client *easy.Client
}

// statusByCode maps a client.ClientErrorCode to an HTTP status. Mirrors
// the TS STATUS_BY_CODE table in typescript/src/middleware/core.ts;
// keep in lockstep — the cross-port parity tests verify byte-for-byte
// equivalence.
var statusByCode = map[client.ClientErrorCode]int{
	// 400 — caller didn't supply what we need
	"MissingFingerprint":          400,
	client.CodeInvalidTokenFormat: 400,
	// 401 — auth (token-level)
	client.CodeNoToken:          401,
	client.CodeTokenExpired:     401,
	client.CodeTokenNotYetValid: 401,
	client.CodeTokenReplayed:    401,
	// 403 — policy / lifecycle block
	client.CodeFingerprintMismatch:   403,
	client.CodeAudienceMismatch:      403,
	client.CodeIssuerMismatch:        403,
	client.CodeLicenseRevoked:        403,
	client.CodeLicenseSuspended:      403,
	client.CodeGraceExpired:          403,
	client.CodeRequiresOnlineRefresh: 403,
	// 404 — bad license / unknown key
	client.CodeInvalidLicenseKey: 404,
	client.CodeUnknownKid:        404,
	// 422 — caller wired the verifier wrong
	client.CodeUnsupportedAlgorithm: 422,
	client.CodeAlgorithmMismatch:    422,
	// 429 — rate limit
	client.CodeRateLimited: 429,
	// 502 — issuer protocol problem (response shape unexpected)
	client.CodeIssuerProtocolError: 502,
	// 503 — transport
	client.CodeIssuerUnreachable: 503,
}

// BuildGuardError translates a Go error from easy.Client.Guard into a
// (status, body) pair suitable for any framework adapter to serialize.
// Exported so the test matrix can call it directly; framework adapters
// call RunGuard rather than this.
func BuildGuardError(err error) (int, GuardErrorBody) {
	var ce *client.ClientError
	if errors.As(err, &ce) {
		status, ok := statusByCode[ce.Code]
		if !ok {
			status = 500
		}
		return status, GuardErrorBody{
			Error:   string(ce.Code),
			Message: ce.Message,
		}
	}
	// Non-ClientError throws are caller bugs (or framework bugs).
	// Surface as 500 with a stable code so log aggregators can alert
	// on these specifically.
	return 500, GuardErrorBody{
		Error:   "InternalError",
		Message: err.Error(),
	}
}

// missingFingerprintResult is the shared "no fingerprint" response —
// 400 MissingFingerprint with an explanation, identical across all
// frameworks.
func missingFingerprintResult(reason string) GuardResult {
	return GuardResult{
		Status: 400,
		Body: GuardErrorBody{
			Error:   "MissingFingerprint",
			Message: reason,
		},
	}
}

// RunGuard is the framework-agnostic guard runner. Each framework
// adapter calls it with a typed Req + a FingerprintExtractor for that
// Req type. On success, the LicenseHandle is non-nil and the adapter
// attaches it to the framework's request context. On failure, the
// adapter writes Status + Body as JSON.
func RunGuard[Req any](
	req Req,
	cfg LicenseGuardConfig,
	extractFingerprint FingerprintExtractor[Req],
	onSuccess OnSuccessHook[Req],
) GuardResult {
	fingerprint, err := extractFingerprint(req)
	if err != nil {
		return missingFingerprintResult(
			"fingerprint extractor returned an error: " + err.Error())
	}
	if fingerprint == "" {
		return missingFingerprintResult("fingerprint extractor returned no value")
	}

	handle, err := cfg.Client.Guard(easy.ValidateInput{Fingerprint: fingerprint})
	if err != nil {
		status, body := BuildGuardError(err)
		return GuardResult{Status: status, Body: body}
	}

	if onSuccess != nil {
		if err := onSuccess(req, handle); err != nil {
			status, body := BuildGuardError(err)
			return GuardResult{Status: status, Body: body}
		}
	}

	return GuardResult{Handle: handle, OK: true}
}
