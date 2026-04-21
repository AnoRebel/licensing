package client

import (
	"errors"
	"fmt"
)

// DeactivateOptions configures the deactivate call.
type DeactivateOptions struct {
	Store       TokenStore
	LicenseKey  string
	Fingerprint string
	Path        string
	Transport   TransportOptions
}

func (o DeactivateOptions) path() string {
	if o.Path != "" {
		return o.Path
	}
	return "/api/licensing/v1/deactivate"
}

// DeactivateResult is the return value of Deactivate.
type DeactivateResult struct {
	IssuerConfirmed bool
}

type deactivateRequest struct {
	LicenseKey  string `json:"license_key"`
	Fingerprint string `json:"fingerprint"`
	Reason      string `json:"reason"`
}

type deactivateResponse struct{}

// Deactivate releases a seat. On success or expected stale-key errors,
// the store is cleared. Other errors propagate without touching the store.
func Deactivate(reason string, opts DeactivateOptions) (*DeactivateResult, error) {
	_, err := PostJSON[deactivateResponse](opts.path(), deactivateRequest{
		LicenseKey:  opts.LicenseKey,
		Fingerprint: opts.Fingerprint,
		Reason:      reason,
	}, opts.Transport)
	if err != nil {
		var ce *ClientError
		if errors.As(err, &ce) && (ce.Code == CodeInvalidLicenseKey || ce.Code == CodeLicenseRevoked) {
			// Token is stale anyway — clear and return non-confirmed.
			if clearErr := opts.Store.Clear(); clearErr != nil {
				return nil, fmt.Errorf("clear store: %w", clearErr)
			}
			return &DeactivateResult{IssuerConfirmed: false}, nil
		}
		return nil, err
	}

	if err := opts.Store.Clear(); err != nil {
		return nil, fmt.Errorf("clear store: %w", err)
	}
	return &DeactivateResult{IssuerConfirmed: true}, nil
}
