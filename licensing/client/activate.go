package client

import "fmt"

// ActivateOptions configures the activate call.
type ActivateOptions struct {
	Store       TokenStore
	Metadata    map[string]any
	Fingerprint string
	Path        string
	Transport   TransportOptions
}

func (o ActivateOptions) path() string {
	if o.Path != "" {
		return o.Path
	}
	return "/api/licensing/v1/activate"
}

// ActivateResult is the return value of Activate.
type ActivateResult struct {
	Token     string
	UsageID   string
	LicenseID string
}

type activateRequest struct {
	Metadata    map[string]any `json:"metadata,omitempty"`
	LicenseKey  string         `json:"license_key"`
	Fingerprint string         `json:"fingerprint"`
}

type activateResponse struct {
	Token     string `json:"token"`
	UsageID   string `json:"usage_id"`
	LicenseID string `json:"license_id"`
}

// Activate POSTs to the issuer to register a seat and obtain a token.
// On success, writes the token to the store. On failure, the store is
// NOT mutated.
func Activate(licenseKey string, opts ActivateOptions) (*ActivateResult, error) {
	resp, err := PostJSON[activateResponse](opts.path(), activateRequest{
		LicenseKey:  licenseKey,
		Fingerprint: opts.Fingerprint,
		Metadata:    opts.Metadata,
	}, opts.Transport)
	if err != nil {
		return nil, err
	}

	if resp.Token == "" {
		return nil, InvalidTokenFormat("issuer returned empty token", nil)
	}
	if resp.UsageID == "" || resp.LicenseID == "" {
		return nil, InvalidTokenFormat(
			"issuer response missing usage_id or license_id", nil)
	}

	if err := opts.Store.Write(StoredTokenState{Token: resp.Token}); err != nil {
		return nil, fmt.Errorf("write token store: %w", err)
	}

	return &ActivateResult{
		Token:     resp.Token,
		UsageID:   resp.UsageID,
		LicenseID: resp.LicenseID,
	}, nil
}
