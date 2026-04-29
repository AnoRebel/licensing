package easy

import (
	"errors"
	"strings"

	"github.com/AnoRebel/licensing/licensing/client"
)

// ClientConfig configures NewClient.
type ClientConfig struct {
	// ServerURL is the issuer base URL. Required.
	ServerURL string
	// Storage is the token store. When nil, defaults to a FileTokenStore
	// rooted at "./.licensing/" so dev "just works"; production deployments
	// should pass an explicit path or their own TokenStore implementation.
	Storage client.TokenStore
	// PathPrefix overrides the default "/api/licensing/v1" prefix.
	PathPrefix string
	// Transport overrides for HTTP clients used by activate/deactivate.
	Transport client.TransportOptions
}

// Client is a high-level offline-first consumer wrapper that hides the
// per-call transport plumbing.
type Client struct {
	serverURL  string
	storage    client.TokenStore
	pathPrefix string
	transport  client.TransportOptions
}

// NewClient constructs a high-level client. Synchronous because nothing
// about client construction needs to touch the network.
func NewClient(config ClientConfig) (*Client, error) {
	if config.ServerURL == "" {
		return nil, errors.New("easy.NewClient: ServerURL is required")
	}
	storage := config.Storage
	if storage == nil {
		storage = client.NewFileTokenStore("./.licensing/")
	}
	pathPrefix := config.PathPrefix
	if pathPrefix == "" {
		pathPrefix = "/api/licensing/v1"
	}
	transport := config.Transport
	if transport.BaseURL == "" {
		transport.BaseURL = strings.TrimSuffix(config.ServerURL, "/")
	}
	return &Client{
		serverURL:  strings.TrimSuffix(config.ServerURL, "/"),
		storage:    storage,
		pathPrefix: pathPrefix,
		transport:  transport,
	}, nil
}

// TokenStore returns the underlying store for power users.
func (c *Client) TokenStore() client.TokenStore { return c.storage }

// ActivateInput carries the per-call inputs for Client.Activate.
type ActivateInput struct {
	Metadata    map[string]any
	Fingerprint string
}

// Activate hits /activate, persists the returned token in the local store.
func (c *Client) Activate(licenseKey string, in ActivateInput) (*client.ActivateResult, error) {
	return client.Activate(licenseKey, client.ActivateOptions{
		Store:       c.storage,
		Fingerprint: in.Fingerprint,
		Metadata:    in.Metadata,
		Path:        c.pathPrefix + "/activate",
		Transport:   c.transport,
	})
}

// Deactivate releases a seat. Idempotent — calling on a revoked usage clears
// the local store but reports IssuerConfirmed=false.
func (c *Client) Deactivate(licenseKey, reason string, in struct{ Fingerprint string }) (*client.DeactivateResult, error) {
	return client.Deactivate(reason, client.DeactivateOptions{
		Store:       c.storage,
		LicenseKey:  licenseKey,
		Fingerprint: in.Fingerprint,
		Path:        c.pathPrefix + "/deactivate",
		Transport:   c.transport,
	})
}

// Validate / Refresh require the consumer to provide an algorithm registry
// and trusted public-key bundle — there's no JWKS-style discovery endpoint
// in the protocol today. Use the primitives directly:
//
//	import "github.com/AnoRebel/licensing/licensing/client"
//	client.Validate(token, client.ValidateOptions{ ... })
