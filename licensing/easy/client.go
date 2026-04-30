package easy

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/client"
)

// ClientVerifyConfig is the public-key bundle + algorithm registry needed
// for offline token verification. There is no JWKS-style discovery
// endpoint in the LIC1 protocol today, so the consumer ships the trust
// material at construction time. Activate / deactivate / heartbeat work
// without this config; Validate and Guard require it.
type ClientVerifyConfig struct {
	// Registry contains one or more algorithm backends. Typically a single
	// backend (the alg the client was provisioned for) to keep the attack
	// surface narrow.
	Registry *lic.AlgorithmRegistry
	// Bindings pins kid → alg pairs. Defeats alg-confusion attacks.
	Bindings *lic.KeyAlgBindings
	// Keys maps kid → trusted public key.
	Keys map[string]lic.KeyRecord
	// ExpectedAudience pins the audience the token MUST be issued for.
	// When non-empty, mismatches surface as
	// *client.ClientError{Code: CodeAudienceMismatch}. Empty means the
	// audience is unpinned and the claim is advisory.
	ExpectedAudience string
	// ExpectedIssuer pins the issuer the token MUST have been signed by.
	// When non-empty, mismatches surface as
	// *client.ClientError{Code: CodeIssuerMismatch}. Empty means the
	// issuer is unpinned and the claim is advisory.
	ExpectedIssuer string
	// SkewSec is the optional clock-skew tolerance in seconds for nbf/exp
	// (default 60).
	SkewSec int64
}

// ClientConfig configures NewClient.
type ClientConfig struct {
	// Storage is the token store. When nil, defaults to a FileTokenStore
	// rooted at "./.licensing/" so dev "just works"; production deployments
	// should pass an explicit path or their own TokenStore implementation.
	Storage client.TokenStore
	// Verify holds the public-key bundle + algorithm registry needed for
	// Validate and Guard. When nil, those methods return a clear error.
	Verify *ClientVerifyConfig
	// NowFunc is the time source for Guard / Validate / Refresh. Defaults
	// to time.Now().Unix.
	NowFunc func() int64
	// ServerURL is the issuer base URL. Required.
	ServerURL string
	// PathPrefix overrides the default "/api/licensing/v1" prefix.
	PathPrefix string
	// Transport overrides for HTTP clients used by activate/deactivate.
	Transport client.TransportOptions
	// GracePeriodSec is the grace-on-unreachable window for Refresh /
	// Guard. Defaults to 7 days. Pass a non-zero negative to opt out (the
	// primitive treats 0 as "no grace").
	GracePeriodSec int64
	// GracePeriodSet differentiates "default" from "explicitly zero"
	// (zero disables grace). Mirrors the field-set pattern used elsewhere.
	GracePeriodSet bool
}

// LicenseHandle is the success-shape returned by Client.Guard. The handle
// exposes the verified claims plus flags that let callers branch on
// grace-period state without re-running the verifier.
type LicenseHandle struct {
	// Entitlements is the resolved entitlements map (or nil when none
	// claimed).
	Entitlements map[string]any
	// LicenseID is the canonical license id from the token.
	LicenseID string
	// UsageID is the canonical usage id from the token.
	UsageID string
	// Status is "active" or "grace".
	Status string
	// MaxUsages is the seat cap from the token.
	MaxUsages int64
	// Exp is the unix seconds at which the token expires.
	Exp int64
	// GraceStartedAt is the unix seconds when grace started, or 0 when
	// not in grace.
	GraceStartedAt int64
	// IsInGrace is true when status == "grace" OR GraceStartedAt != 0.
	IsInGrace bool
}

// Client is a high-level offline-first consumer wrapper that hides the
// per-call transport plumbing.
type Client struct {
	storage        client.TokenStore
	verify         *ClientVerifyConfig
	nowFunc        func() int64
	serverURL      string
	pathPrefix     string
	transport      client.TransportOptions
	gracePeriodSec int64
}

// defaultGracePeriodSec mirrors the TS DEFAULT_GRACE_PERIOD_SEC: 7 days.
const defaultGracePeriodSec int64 = 7 * 24 * 3600

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
	nowFunc := config.NowFunc
	if nowFunc == nil {
		nowFunc = func() int64 { return time.Now().Unix() }
	}
	grace := defaultGracePeriodSec
	if config.GracePeriodSet {
		grace = config.GracePeriodSec
	}
	return &Client{
		serverURL:      strings.TrimSuffix(config.ServerURL, "/"),
		storage:        storage,
		pathPrefix:     pathPrefix,
		transport:      transport,
		verify:         config.Verify,
		nowFunc:        nowFunc,
		gracePeriodSec: grace,
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

// ValidateInput carries the per-call inputs for Client.Validate / Guard.
type ValidateInput struct {
	Fingerprint string
}

// requireVerify returns the configured verify bundle or a clear error
// pointing at the docs when verify config is missing.
func (c *Client) requireVerify(method string) (*ClientVerifyConfig, error) {
	if c.verify == nil {
		return nil, fmt.Errorf(
			"easy.Client.%s: verify config is required (ClientConfig.Verify); "+
				"the LIC1 protocol has no JWKS-style discovery endpoint, so the "+
				"public-key bundle must be supplied at construction time", method)
	}
	return c.verify, nil
}

// Validate verifies the persisted token offline. Returns a typed
// *client.ValidateResult on success, or a *client.ClientError discriminated
// via .Code (NoToken, TokenExpired, FingerprintMismatch, UnknownKid, …).
// Requires Verify config at construction.
func (c *Client) Validate(in ValidateInput) (*client.ValidateResult, error) {
	verify, err := c.requireVerify("Validate")
	if err != nil {
		return nil, err
	}
	state, err := c.storage.Read()
	if err != nil {
		return nil, fmt.Errorf("read token store: %w", err)
	}
	if state.Token == "" {
		return nil, client.NoToken("")
	}
	return client.Validate(state.Token, client.ValidateOptions{
		Registry:         verify.Registry,
		Bindings:         verify.Bindings,
		Keys:             verify.Keys,
		ExpectedAudience: verify.ExpectedAudience,
		ExpectedIssuer:   verify.ExpectedIssuer,
		Fingerprint:      in.Fingerprint,
		NowSec:           c.nowFunc(),
		SkewSec:          verify.SkewSec,
	})
}

// Refresh proactively refreshes or force-refreshes the stored token.
// Returns the tagged outcome (*client.RefreshOutcome) describing the
// result (refreshed / not-due / grace-entered / grace-continued) on
// success, or a *client.ClientError on hard failures (LicenseRevoked,
// GraceExpired, …).
//
// When the primitive enters or continues grace because /refresh was
// unreachable, this wrapper probes GET /health to disambiguate a real
// outage from a partial outage where /refresh is broken but the issuer
// process is up. Health-OK + refresh-fail rolls back the just-written
// grace marker (if any) and surfaces ErrIssuerProtocolError instead —
// preserving grace semantics for actual network failures only.
func (c *Client) Refresh() (*client.RefreshOutcome, error) {
	// Snapshot grace state BEFORE the primitive runs, so we can roll back
	// if the disambiguation probe says the issuer is actually up.
	preState, err := c.storage.Read()
	if err != nil {
		return nil, fmt.Errorf("read token store: %w", err)
	}
	preGrace := preState.GraceStartSec

	out, err := client.Refresh(client.RefreshOptions{
		Store:          c.storage,
		Path:           c.pathPrefix + "/refresh",
		Transport:      c.transport,
		NowSec:         c.nowFunc(),
		GraceWindowSec: c.gracePeriodSec,
		GraceWindowSet: true,
	})
	if err != nil {
		return nil, err
	}

	// Only the grace branches need disambiguation. Refreshed / NotDue
	// pass through unchanged.
	if out.Kind != client.RefreshKindGraceEntered && out.Kind != client.RefreshKindGraceContinued {
		return out, nil
	}

	healthy, _ := c.probeHealth()
	if !healthy {
		// Real outage — keep grace state, return outcome.
		return out, nil
	}

	// Issuer is up but /refresh failed. Roll back any grace marker we
	// just wrote (only for GraceEntered — GraceContinued didn't change
	// the state) and surface a typed protocol error.
	if out.Kind == client.RefreshKindGraceEntered {
		if writeErr := c.storage.Write(client.StoredTokenState{
			Token:         preState.Token,
			GraceStartSec: preGrace,
		}); writeErr != nil {
			return nil, fmt.Errorf("rollback grace marker: %w", writeErr)
		}
	}
	return nil, &client.ClientError{
		Code: client.CodeIssuerProtocolError,
		Message: "/refresh failed but /health is OK — issuer process is up but the " +
			"refresh route is broken; not entering grace",
	}
}

// probeHealth issues a single GET to {pathPrefix}/health and reports
// whether the issuer responded with HTTP 200 (any body shape). Any
// non-200 status — 503, 4xx, or a transport error — counts as "not
// healthy". The probe reuses the configured transport's *http.Client
// when set so tests can plug a fake; otherwise falls back to a 5s
// short-lived client (the probe must be cheap, even if /refresh has a
// longer timeout).
func (c *Client) probeHealth() (bool, error) {
	httpClient := c.transport.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Second}
	}
	url := strings.TrimRight(c.transport.BaseURL, "/") + "/" + strings.TrimLeft(c.pathPrefix+"/health", "/")
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	for k, v := range c.transport.Headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK, nil
}

// Guard is the single-call lifecycle: verify the stored token offline,
// refresh on demand when force_online_after has elapsed, and surface a
// LicenseHandle on success. Errors are *client.ClientError with a typed
// .Code — branch via errors.Is(err, client.ErrXxx) or by inspecting .Code.
//
// Behaviour:
//
//  1. Read the stored token; return *ClientError(NoToken) when absent.
//  2. Attempt Refresh. The primitive handles not-due / refreshed /
//     grace-entered / grace-continued internally; only hard failures
//     (revoked, seat-limit, GraceExpired) escape as errors.
//  3. Re-read the store (refresh may have persisted a new token / grace
//     marker) and verify offline with the configured public keys.
//  4. Build and return a LicenseHandle from the validate result + the
//     fresh grace marker.
func (c *Client) Guard(in ValidateInput) (*LicenseHandle, error) {
	verify, err := c.requireVerify("Guard")
	if err != nil {
		return nil, err
	}
	state, err := c.storage.Read()
	if err != nil {
		return nil, fmt.Errorf("read token store: %w", err)
	}
	if state.Token == "" {
		return nil, client.NoToken("")
	}

	// Step 1: refresh if needed. Hard failures propagate.
	if _, err := c.Refresh(); err != nil {
		return nil, err
	}

	// Step 2: re-read store (refresh may have persisted new state).
	fresh, err := c.storage.Read()
	if err != nil {
		return nil, fmt.Errorf("read token store: %w", err)
	}
	if fresh.Token == "" {
		// Refresh shouldn't clear the token, but be defensive.
		return nil, client.NoToken("")
	}

	// Step 3: offline verify.
	result, err := client.Validate(fresh.Token, client.ValidateOptions{
		Registry:         verify.Registry,
		Bindings:         verify.Bindings,
		Keys:             verify.Keys,
		ExpectedAudience: verify.ExpectedAudience,
		ExpectedIssuer:   verify.ExpectedIssuer,
		Fingerprint:      in.Fingerprint,
		NowSec:           c.nowFunc(),
		SkewSec:          verify.SkewSec,
	})
	if err != nil {
		return nil, err
	}

	handle := &LicenseHandle{
		LicenseID:    result.LicenseID,
		UsageID:      result.UsageID,
		Status:       result.Status,
		MaxUsages:    result.MaxUsages,
		Exp:          result.Exp,
		Entitlements: result.Entitlements,
	}
	if fresh.GraceStartSec != nil {
		handle.GraceStartedAt = *fresh.GraceStartSec
	}
	handle.IsInGrace = result.Status == "grace" || fresh.GraceStartSec != nil
	return handle, nil
}

// HeartbeatInput configures Client.Heartbeat.
type HeartbeatInput struct {
	OnError        func(error)
	OnSuccess      func()
	LicenseKey     string
	Fingerprint    string
	RuntimeVersion string
	IntervalSec    int
}

// Heartbeat builds a *client.Heartbeat scheduler. The returned object
// exposes Start(), Stop(), TickNow(). Defaults: 1-hour interval (the
// primitive clamps anything below 60s to 3600s).
func (c *Client) Heartbeat(in HeartbeatInput) *client.Heartbeat {
	return client.NewHeartbeat(client.HeartbeatOptions{
		Store:          c.storage,
		OnError:        in.OnError,
		OnSuccess:      in.OnSuccess,
		NowFunc:        c.nowFunc,
		LicenseKey:     in.LicenseKey,
		Fingerprint:    in.Fingerprint,
		RuntimeVersion: in.RuntimeVersion,
		Path:           c.pathPrefix + "/heartbeat",
		Transport:      c.transport,
		IntervalSec:    in.IntervalSec,
	})
}
