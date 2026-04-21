package licensing

import (
	"errors"
	"fmt"
)

// ErrorCode mirrors the TypeScript `LicensingErrorCode` union in
// typescript/packages/core/src/errors.ts. When adding a new code, update both
// files in lockstep — the cross-language interop test asserts parity.
type ErrorCode string

// ErrorCode values. Grouped by subsystem; parity with the TS
// `LicensingErrorCode` union is asserted by the interop test suite.
const (
	// Canonical JSON
	CodeCanonicalJSONInvalidType     ErrorCode = "CanonicalJSONInvalidType"
	CodeCanonicalJSONInvalidNumber   ErrorCode = "CanonicalJSONInvalidNumber"
	CodeCanonicalJSONInvalidUTF8     ErrorCode = "CanonicalJSONInvalidUTF8"
	CodeCanonicalJSONInvalidTopLevel ErrorCode = "CanonicalJSONInvalidTopLevel"
	CodeCanonicalJSONDuplicateKey    ErrorCode = "CanonicalJSONDuplicateKey"
	CodeCanonicalJSONUnknownField    ErrorCode = "CanonicalJSONUnknownField"

	// Token format
	CodeUnsupportedTokenFormat ErrorCode = "UnsupportedTokenFormat"
	CodeTokenMalformed         ErrorCode = "TokenMalformed"
	CodeTokenSignatureInvalid  ErrorCode = "TokenSignatureInvalid"
	CodeTokenExpired           ErrorCode = "TokenExpired"
	CodeTokenNotYetValid       ErrorCode = "TokenNotYetValid"

	// Crypto
	CodeUnsupportedAlgorithm       ErrorCode = "UnsupportedAlgorithm"
	CodeAlgorithmAlreadyRegistered ErrorCode = "AlgorithmAlreadyRegistered"
	CodeAlgorithmMismatch          ErrorCode = "AlgorithmMismatch"
	CodeUnknownKid                 ErrorCode = "UnknownKid"
	CodeInsufficientKeyStrength    ErrorCode = "InsufficientKeyStrength"
	CodeMissingKeyPassphrase       ErrorCode = "MissingKeyPassphrase"
	CodeKeyDecryptionFailed        ErrorCode = "KeyDecryptionFailed"

	// Licenses & usages
	CodeLicenseKeyConflict         ErrorCode = "LicenseKeyConflict"
	CodeLicenseNotFound            ErrorCode = "LicenseNotFound"
	CodeLicenseRevoked             ErrorCode = "LicenseRevoked"
	CodeLicenseSuspended           ErrorCode = "LicenseSuspended"
	CodeLicenseExpired             ErrorCode = "LicenseExpired"
	CodeIllegalLifecycleTransition ErrorCode = "IllegalLifecycleTransition"
	CodeSeatLimitExceeded          ErrorCode = "SeatLimitExceeded"
	CodeFingerprintRejected        ErrorCode = "FingerprintRejected"
	CodeInvalidLicenseKey          ErrorCode = "InvalidLicenseKey"

	// Storage
	CodeImmutableAuditLog         ErrorCode = "ImmutableAuditLog"
	CodeUniqueConstraintViolation ErrorCode = "UniqueConstraintViolation"

	// Grace / client
	CodeGraceExpired ErrorCode = "GraceExpired"

	// Auth / transport
	CodeUnauthenticated ErrorCode = "Unauthenticated"
	CodeRateLimited     ErrorCode = "RateLimited"
)

// Error is the common type for every error returned by this module. Consumers
// can discriminate with errors.As or by inspecting Code().
type Error struct {
	cause   error
	Details map[string]any
	Code    ErrorCode
	Message string
}

// Error implements the error interface.
func (e *Error) Error() string {
	if e.Message == "" {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap exposes the underlying cause for errors.Is / errors.As chains.
func (e *Error) Unwrap() error { return e.cause }

// Is allows errors.Is matching on a sentinel of the same code. Two *Error
// values with the same Code are considered equivalent for Is purposes.
func (e *Error) Is(target error) bool {
	var other *Error
	if !errors.As(target, &other) {
		return false
	}
	return e.Code == other.Code
}

// newError is the internal constructor used throughout the package.
func newError(code ErrorCode, msg string, details map[string]any) *Error {
	return &Error{Code: code, Message: msg, Details: details}
}

// NewError is the exported constructor. Storage adapters and other
// package consumers use this to build domain errors that carry an
// ErrorCode (for errors.Is / errors.As discrimination) plus a
// human-readable message and optional structured details.
//
// Prefer the package-local sentinels (ErrTokenExpired, etc.) when you
// just need discrimination by code; build a NewError when you also need
// to attach context like the offending id or field name.
func NewError(code ErrorCode, msg string, details map[string]any) *Error {
	return newError(code, msg, details)
}

// Sentinel values — callers use errors.Is(err, licensing.ErrTokenExpired) for
// discrimination. Each sentinel carries only its code; messages are blank so
// the sentinel itself does not accidentally get surfaced to end users.
//
//nolint:revive // block-level doc applies to every Err* sentinel below.
var (
	ErrCanonicalJSONInvalidType     = &Error{Code: CodeCanonicalJSONInvalidType}
	ErrCanonicalJSONInvalidNumber   = &Error{Code: CodeCanonicalJSONInvalidNumber}
	ErrCanonicalJSONInvalidUTF8     = &Error{Code: CodeCanonicalJSONInvalidUTF8}
	ErrCanonicalJSONInvalidTopLevel = &Error{Code: CodeCanonicalJSONInvalidTopLevel}
	ErrCanonicalJSONDuplicateKey    = &Error{Code: CodeCanonicalJSONDuplicateKey}
	ErrCanonicalJSONUnknownField    = &Error{Code: CodeCanonicalJSONUnknownField}

	ErrUnsupportedTokenFormat = &Error{Code: CodeUnsupportedTokenFormat}
	ErrTokenMalformed         = &Error{Code: CodeTokenMalformed}
	ErrTokenSignatureInvalid  = &Error{Code: CodeTokenSignatureInvalid}
	ErrTokenExpired           = &Error{Code: CodeTokenExpired}
	ErrTokenNotYetValid       = &Error{Code: CodeTokenNotYetValid}

	ErrUnsupportedAlgorithm       = &Error{Code: CodeUnsupportedAlgorithm}
	ErrAlgorithmAlreadyRegistered = &Error{Code: CodeAlgorithmAlreadyRegistered}
	ErrAlgorithmMismatch          = &Error{Code: CodeAlgorithmMismatch}
	ErrUnknownKid                 = &Error{Code: CodeUnknownKid}
	ErrInsufficientKeyStrength    = &Error{Code: CodeInsufficientKeyStrength}
	ErrMissingKeyPassphrase       = &Error{Code: CodeMissingKeyPassphrase}
	ErrKeyDecryptionFailed        = &Error{Code: CodeKeyDecryptionFailed}

	ErrLicenseKeyConflict         = &Error{Code: CodeLicenseKeyConflict}
	ErrLicenseNotFound            = &Error{Code: CodeLicenseNotFound}
	ErrLicenseRevoked             = &Error{Code: CodeLicenseRevoked}
	ErrLicenseSuspended           = &Error{Code: CodeLicenseSuspended}
	ErrLicenseExpired             = &Error{Code: CodeLicenseExpired}
	ErrIllegalLifecycleTransition = &Error{Code: CodeIllegalLifecycleTransition}
	ErrSeatLimitExceeded          = &Error{Code: CodeSeatLimitExceeded}
	ErrFingerprintRejected        = &Error{Code: CodeFingerprintRejected}
	ErrInvalidLicenseKey          = &Error{Code: CodeInvalidLicenseKey}

	ErrImmutableAuditLog         = &Error{Code: CodeImmutableAuditLog}
	ErrUniqueConstraintViolation = &Error{Code: CodeUniqueConstraintViolation}

	ErrGraceExpired = &Error{Code: CodeGraceExpired}

	ErrUnauthenticated = &Error{Code: CodeUnauthenticated}
	ErrRateLimited     = &Error{Code: CodeRateLimited}
)

// -- Factory helpers for errors with structured details.
//
// These exist so call sites stay readable and the details map shape matches
// what the TS `errors` helpers emit (the interop test compares both).

func canonicalInvalidType(msg string, details map[string]any) *Error {
	return newError(CodeCanonicalJSONInvalidType, msg, details)
}

func canonicalInvalidNumber(msg string, details map[string]any) *Error {
	return newError(CodeCanonicalJSONInvalidNumber, msg, details)
}

func canonicalInvalidUTF8(msg string, details map[string]any) *Error {
	return newError(CodeCanonicalJSONInvalidUTF8, msg, details)
}

func canonicalInvalidTopLevel(msg string) *Error {
	return newError(CodeCanonicalJSONInvalidTopLevel, msg, nil)
}
