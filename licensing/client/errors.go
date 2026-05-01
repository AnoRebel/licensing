package client

import (
	"errors"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ClientErrorCode enumerates all error codes that the client package can
// surface. This is deliberately a narrower set than the core
// licensing.ErrorCode — the client collapses internal concerns into
// user-actionable buckets.
type ClientErrorCode string

// ClientErrorCode values. A user-actionable superset of the issuer-side
// licensing.ErrorCode enum; unknown issuer codes collapse to
// CodeIssuerProtocolError so grace-on-unreachable doesn't misfire.
const (
	CodeInvalidLicenseKey     ClientErrorCode = "InvalidLicenseKey"
	CodeFingerprintMismatch   ClientErrorCode = "FingerprintMismatch"
	CodeAudienceMismatch      ClientErrorCode = "AudienceMismatch"
	CodeIssuerMismatch        ClientErrorCode = "IssuerMismatch"
	CodeTokenReplayed         ClientErrorCode = "TokenReplayed"
	CodeTokenExpired          ClientErrorCode = "TokenExpired"
	CodeTokenNotYetValid      ClientErrorCode = "TokenNotYetValid"
	CodeSeatLimitExceeded     ClientErrorCode = "SeatLimitExceeded"
	CodeLicenseRevoked        ClientErrorCode = "LicenseRevoked"
	CodeLicenseSuspended      ClientErrorCode = "LicenseSuspended"
	CodeRequiresOnlineRefresh ClientErrorCode = "RequiresOnlineRefresh"
	CodeGraceExpired          ClientErrorCode = "GraceExpired"
	CodeNoToken               ClientErrorCode = "NoToken"
	CodeIssuerUnreachable     ClientErrorCode = "IssuerUnreachable"
	CodeRateLimited           ClientErrorCode = "RateLimited"
	CodeInvalidTokenFormat    ClientErrorCode = "InvalidTokenFormat"
	CodeUnsupportedAlgorithm  ClientErrorCode = "UnsupportedAlgorithm"
	CodeAlgorithmMismatch     ClientErrorCode = "AlgorithmMismatch"
	CodeUnknownKid            ClientErrorCode = "UnknownKid"
	// CodeIssuerProtocolError is returned when the issuer's response does
	// not conform to the expected protocol (unknown error code, malformed
	// envelope, etc). Deliberately distinct from IssuerUnreachable so that
	// grace-on-unreachable logic does NOT engage for protocol violations.
	CodeIssuerProtocolError ClientErrorCode = "IssuerProtocolError"
)

// ClientError is the single concrete error type surfaced by the client
// package. Callers distinguish errors via code-based sentinels and
// errors.Is.
type ClientError struct {
	cause         error
	Code          ClientErrorCode
	Message       string
	HTTPStatus    int
	RetryAfterSec int
}

// Error implements the error interface.
func (e *ClientError) Error() string {
	if e.cause != nil {
		return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.cause)
	}
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Unwrap exposes the underlying cause for errors.Is / errors.As.
func (e *ClientError) Unwrap() error { return e.cause }

// Is supports errors.Is matching by Code only (sentinel pattern).
func (e *ClientError) Is(target error) bool {
	if t, ok := target.(*ClientError); ok {
		return e.Code == t.Code
	}
	return false
}

// ---------- Sentinels (for errors.Is) ----------

// Err* sentinels carry only the Code so callers can discriminate without
// leaking the sentinel's empty Message to end users.
//
//nolint:revive // block-level doc applies to every sentinel below.
var (
	ErrInvalidLicenseKey     = &ClientError{Code: CodeInvalidLicenseKey}
	ErrFingerprintMismatch   = &ClientError{Code: CodeFingerprintMismatch}
	ErrAudienceMismatch      = &ClientError{Code: CodeAudienceMismatch}
	ErrIssuerMismatch        = &ClientError{Code: CodeIssuerMismatch}
	ErrTokenReplayed         = &ClientError{Code: CodeTokenReplayed}
	ErrTokenExpired          = &ClientError{Code: CodeTokenExpired}
	ErrTokenNotYetValid      = &ClientError{Code: CodeTokenNotYetValid}
	ErrSeatLimitExceeded     = &ClientError{Code: CodeSeatLimitExceeded}
	ErrLicenseRevoked        = &ClientError{Code: CodeLicenseRevoked}
	ErrLicenseSuspended      = &ClientError{Code: CodeLicenseSuspended}
	ErrRequiresOnlineRefresh = &ClientError{Code: CodeRequiresOnlineRefresh}
	ErrGraceExpired          = &ClientError{Code: CodeGraceExpired}
	ErrNoToken               = &ClientError{Code: CodeNoToken}
	ErrIssuerUnreachable     = &ClientError{Code: CodeIssuerUnreachable}
	ErrRateLimited           = &ClientError{Code: CodeRateLimited}
	ErrInvalidTokenFormat    = &ClientError{Code: CodeInvalidTokenFormat}
	ErrUnsupportedAlgorithm  = &ClientError{Code: CodeUnsupportedAlgorithm}
	ErrAlgorithmMismatch     = &ClientError{Code: CodeAlgorithmMismatch}
	ErrUnknownKid            = &ClientError{Code: CodeUnknownKid}
	ErrIssuerProtocolError   = &ClientError{Code: CodeIssuerProtocolError}
)

// ---------- Factories ----------

func newClientError(code ClientErrorCode, msg string) *ClientError {
	return &ClientError{Code: code, Message: msg}
}

func newClientErrorWithCause(code ClientErrorCode, msg string, cause error) *ClientError {
	return &ClientError{Code: code, Message: msg, cause: cause}
}

// InvalidLicenseKey constructs a CodeInvalidLicenseKey ClientError.
func InvalidLicenseKey(msg string) *ClientError {
	if msg == "" {
		msg = "license key not recognized"
	}
	return newClientError(CodeInvalidLicenseKey, msg)
}

// FingerprintMismatch constructs a CodeFingerprintMismatch ClientError.
func FingerprintMismatch(msg string) *ClientError {
	if msg == "" {
		msg = "token fingerprint does not match this device"
	}
	return newClientError(CodeFingerprintMismatch, msg)
}

// AudienceMismatch constructs a CodeAudienceMismatch ClientError. Surfaces
// when the verifier pinned an expected audience and the token's `aud`
// claim does not match (or is absent).
func AudienceMismatch(msg string) *ClientError {
	if msg == "" {
		msg = "token audience does not match the verifier-pinned audience"
	}
	return newClientError(CodeAudienceMismatch, msg)
}

// IssuerMismatch constructs a CodeIssuerMismatch ClientError. Surfaces
// when the verifier pinned an expected issuer and the token's `iss`
// claim does not match (or is absent).
func IssuerMismatch(msg string) *ClientError {
	if msg == "" {
		msg = "token issuer does not match the verifier-pinned issuer"
	}
	return newClientError(CodeIssuerMismatch, msg)
}

// TokenReplayed constructs a CodeTokenReplayed ClientError. Surfaces
// when the verifier has a JtiLedger configured and the token's jti
// claim was previously recorded — the second use of a single-use
// token is rejected at the validate step.
func TokenReplayed(msg string) *ClientError {
	if msg == "" {
		msg = "token jti has already been used (replay rejected)"
	}
	return newClientError(CodeTokenReplayed, msg)
}

// TokenExpired constructs a CodeTokenExpired ClientError.
func TokenExpired(msg string) *ClientError {
	if msg == "" {
		msg = "token has expired"
	}
	return newClientError(CodeTokenExpired, msg)
}

// TokenNotYetValid constructs a CodeTokenNotYetValid ClientError.
func TokenNotYetValid(msg string) *ClientError {
	if msg == "" {
		msg = "token is not yet valid"
	}
	return newClientError(CodeTokenNotYetValid, msg)
}

// SeatLimitExceeded constructs a CodeSeatLimitExceeded ClientError.
func SeatLimitExceeded(msg string) *ClientError {
	if msg == "" {
		msg = "seat limit exceeded"
	}
	return newClientError(CodeSeatLimitExceeded, msg)
}

// LicenseRevoked constructs a CodeLicenseRevoked ClientError.
func LicenseRevoked(msg string) *ClientError {
	if msg == "" {
		msg = "license is revoked"
	}
	return newClientError(CodeLicenseRevoked, msg)
}

// LicenseSuspended constructs a CodeLicenseSuspended ClientError.
func LicenseSuspended(msg string) *ClientError {
	if msg == "" {
		msg = "license is suspended"
	}
	return newClientError(CodeLicenseSuspended, msg)
}

// RequiresOnlineRefresh constructs a CodeRequiresOnlineRefresh ClientError.
func RequiresOnlineRefresh(msg string) *ClientError {
	if msg == "" {
		msg = "force_online_after deadline passed; online refresh required"
	}
	return newClientError(CodeRequiresOnlineRefresh, msg)
}

// GraceExpired constructs a CodeGraceExpired ClientError.
func GraceExpired(msg string) *ClientError {
	if msg == "" {
		msg = "grace window has expired"
	}
	return newClientError(CodeGraceExpired, msg)
}

// NoToken constructs a CodeNoToken ClientError.
func NoToken(msg string) *ClientError {
	if msg == "" {
		msg = "no stored token"
	}
	return newClientError(CodeNoToken, msg)
}

// IssuerUnreachable constructs a CodeIssuerUnreachable ClientError,
// preserving the underlying network cause for errors.Is chains.
func IssuerUnreachable(msg string, cause error) *ClientError {
	if msg == "" {
		msg = "issuer is unreachable"
	}
	return newClientErrorWithCause(CodeIssuerUnreachable, msg, cause)
}

// RateLimited constructs a CodeRateLimited ClientError carrying the
// server-supplied Retry-After hint.
func RateLimited(retryAfterSec int, msg string) *ClientError {
	if msg == "" {
		msg = "rate limited by issuer"
	}
	return &ClientError{
		Code:          CodeRateLimited,
		Message:       msg,
		HTTPStatus:    429,
		RetryAfterSec: retryAfterSec,
	}
}

// InvalidTokenFormat constructs a CodeInvalidTokenFormat ClientError,
// preserving the underlying parse error for debugging.
func InvalidTokenFormat(msg string, cause error) *ClientError {
	if msg == "" {
		msg = "invalid token format"
	}
	return newClientErrorWithCause(CodeInvalidTokenFormat, msg, cause)
}

// UnsupportedAlgorithm constructs a CodeUnsupportedAlgorithm ClientError
// naming the algorithm that could not be handled.
func UnsupportedAlgorithm(alg string) *ClientError {
	return newClientError(CodeUnsupportedAlgorithm,
		fmt.Sprintf("unsupported algorithm: %s", alg))
}

// AlgorithmMismatch constructs a CodeAlgorithmMismatch ClientError
// carrying the expected vs. observed algorithm names.
func AlgorithmMismatch(expected, actual string) *ClientError {
	return newClientError(CodeAlgorithmMismatch,
		fmt.Sprintf("algorithm mismatch: expected %s, got %s", expected, actual))
}

// UnknownKid constructs a CodeUnknownKid ClientError identifying the
// kid that the local key registry could not resolve.
func UnknownKid(kid string) *ClientError {
	return newClientError(CodeUnknownKid,
		fmt.Sprintf("unknown kid: %s", kid))
}

// ---------- Issuer-to-client code mapping ----------

var issuerCodeMap = map[string]ClientErrorCode{
	"InvalidLicenseKey":    CodeInvalidLicenseKey,
	"FingerprintRejected":  CodeFingerprintMismatch,
	"SeatLimitExceeded":    CodeSeatLimitExceeded,
	"LicenseRevoked":       CodeLicenseRevoked,
	"LicenseSuspended":     CodeLicenseSuspended,
	"LicenseExpired":       CodeTokenExpired,
	"RateLimited":          CodeRateLimited,
	"UnknownKid":           CodeUnknownKid,
	"AlgorithmMismatch":    CodeAlgorithmMismatch,
	"UnsupportedAlgorithm": CodeUnsupportedAlgorithm,
}

// FromIssuerCode maps an issuer error response to a ClientError. Unknown
// codes degrade to IssuerUnreachable with the original message preserved.
func FromIssuerCode(code, message string, httpStatus, retryAfterSec int) *ClientError {
	if cc, ok := issuerCodeMap[code]; ok {
		return &ClientError{
			Code:          cc,
			Message:       message,
			HTTPStatus:    httpStatus,
			RetryAfterSec: retryAfterSec,
		}
	}
	return &ClientError{
		Code:       CodeIssuerProtocolError,
		Message:    fmt.Sprintf("unknown issuer error [%s]: %s", code, message),
		HTTPStatus: httpStatus,
	}
}

// TranslateVerifyError maps a core licensing.Error from Verify into a
// ClientError. Non-licensing errors pass through unchanged.
func TranslateVerifyError(err error) error {
	if err == nil {
		return nil
	}
	var le *lic.Error
	if !errors.As(err, &le) {
		return err
	}
	switch le.Code {
	case lic.CodeUnknownKid:
		return newClientErrorWithCause(CodeUnknownKid, le.Error(), err)
	case lic.CodeAlgorithmMismatch:
		return newClientErrorWithCause(CodeAlgorithmMismatch, le.Error(), err)
	case lic.CodeUnsupportedAlgorithm:
		return newClientErrorWithCause(CodeUnsupportedAlgorithm, le.Error(), err)
	case lic.CodeTokenSignatureInvalid:
		return newClientErrorWithCause(CodeInvalidTokenFormat, le.Error(), err)
	case lic.CodeTokenMalformed:
		return newClientErrorWithCause(CodeInvalidTokenFormat, le.Error(), err)
	case lic.CodeUnsupportedTokenFormat:
		return newClientErrorWithCause(CodeInvalidTokenFormat, le.Error(), err)
	default:
		// Preserve the single-error-type invariant: every lic.Error leaving
		// the client surface is a *ClientError. Unknown core codes collapse
		// to InvalidTokenFormat rather than leaking through raw.
		return newClientErrorWithCause(CodeInvalidTokenFormat, le.Error(), err)
	}
}
