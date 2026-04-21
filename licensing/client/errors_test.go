package client

import (
	"errors"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

func TestClientError_ErrorsIs_MatchesByCode(t *testing.T) {
	err := TokenExpired("custom message")
	if !errors.Is(err, ErrTokenExpired) {
		t.Fatal("errors.Is should match by code")
	}
	if errors.Is(err, ErrLicenseRevoked) {
		t.Fatal("errors.Is should not match a different code")
	}
}

func TestClientError_Unwrap(t *testing.T) {
	cause := errors.New("underlying")
	err := IssuerUnreachable("down", cause)
	if !errors.Is(err, cause) {
		t.Fatal("errors.Is should traverse Unwrap to cause")
	}
	if !errors.Is(err, ErrIssuerUnreachable) {
		t.Fatal("code sentinel should still match")
	}
}

func TestClientError_RateLimited_SetsFields(t *testing.T) {
	err := RateLimited(42, "")
	if err.HTTPStatus != 429 {
		t.Fatalf("expected 429, got %d", err.HTTPStatus)
	}
	if err.RetryAfterSec != 42 {
		t.Fatalf("expected 42, got %d", err.RetryAfterSec)
	}
	if err.Message == "" {
		t.Fatal("expected default message")
	}
}

func TestFromIssuerCode_MappedCodes(t *testing.T) {
	cases := []struct {
		issuer string
		want   ClientErrorCode
	}{
		{"InvalidLicenseKey", CodeInvalidLicenseKey},
		{"FingerprintRejected", CodeFingerprintMismatch},
		{"SeatLimitExceeded", CodeSeatLimitExceeded},
		{"LicenseRevoked", CodeLicenseRevoked},
		{"LicenseSuspended", CodeLicenseSuspended},
		{"LicenseExpired", CodeTokenExpired},
		{"RateLimited", CodeRateLimited},
		{"UnknownKid", CodeUnknownKid},
		{"AlgorithmMismatch", CodeAlgorithmMismatch},
		{"UnsupportedAlgorithm", CodeUnsupportedAlgorithm},
	}
	for _, tc := range cases {
		ce := FromIssuerCode(tc.issuer, "msg", 400, 0)
		if ce.Code != tc.want {
			t.Errorf("%s: expected %s, got %s", tc.issuer, tc.want, ce.Code)
		}
	}
}

func TestFromIssuerCode_UnknownMapsToProtocolError(t *testing.T) {
	ce := FromIssuerCode("SomethingNew", "wat", 500, 0)
	if ce.Code != CodeIssuerProtocolError {
		t.Fatalf("expected IssuerProtocolError, got %s", ce.Code)
	}
	if ce.HTTPStatus != 500 {
		t.Fatalf("status not propagated: %d", ce.HTTPStatus)
	}
	// Critical: must NOT match IssuerUnreachable sentinel — otherwise
	// refresh.go would engage grace logic on a protocol violation.
	if errors.Is(ce, ErrIssuerUnreachable) {
		t.Fatal("protocol error must not match IssuerUnreachable")
	}
}

func TestTranslateVerifyError_PassThroughOnNil(t *testing.T) {
	if TranslateVerifyError(nil) != nil {
		t.Fatal("nil should pass through")
	}
}

func TestTranslateVerifyError_PassThroughOnForeign(t *testing.T) {
	e := errors.New("not a lic error")
	if got := TranslateVerifyError(e); got != e {
		t.Fatal("foreign errors should pass through unchanged")
	}
}

func TestTranslateVerifyError_MapsLicCodes(t *testing.T) {
	cases := []struct {
		licCode lic.ErrorCode
		want    ClientErrorCode
	}{
		{lic.CodeUnknownKid, CodeUnknownKid},
		{lic.CodeAlgorithmMismatch, CodeAlgorithmMismatch},
		{lic.CodeUnsupportedAlgorithm, CodeUnsupportedAlgorithm},
		{lic.CodeTokenSignatureInvalid, CodeInvalidTokenFormat},
		{lic.CodeTokenMalformed, CodeInvalidTokenFormat},
		{lic.CodeUnsupportedTokenFormat, CodeInvalidTokenFormat},
	}
	for _, tc := range cases {
		licErr := &lic.Error{Code: tc.licCode, Message: "x"}
		out := TranslateVerifyError(licErr)
		var ce *ClientError
		if !errors.As(out, &ce) {
			t.Errorf("%s: expected ClientError, got %T", tc.licCode, out)
			continue
		}
		if ce.Code != tc.want {
			t.Errorf("%s: expected %s, got %s", tc.licCode, tc.want, ce.Code)
		}
	}
}
