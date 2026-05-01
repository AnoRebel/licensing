package easy_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/client"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/easy"
)

// ---------- forgeToken — Go-side parity with TS forgeToken helper ----------

// forgedToken bundles a freshly-signed token with the verify dependencies
// needed to round-trip it through client.Validate / easy.Client.Guard.
type forgedToken struct {
	Registry *lic.AlgorithmRegistry
	Bindings *lic.KeyAlgBindings
	Keys     map[string]lic.KeyRecord
	Token    string
}

// forgeOpts is the equivalent of the TS forgeToken's overrides argument.
// Any zero/nil field falls back to a sensible default.
type forgeOpts struct {
	ForceOnlineAfter *int64
	Exp              *int64
	Nbf              *int64
	Iat              *int64
	UsageFingerprint string
	Status           string
	NowSec           int64
}

func forgeToken(t *testing.T, o forgeOpts) forgedToken {
	t.Helper()

	now := o.NowSec
	if now == 0 {
		now = 2_000_000_000
	}
	fingerprint := o.UsageFingerprint
	if fingerprint == "" {
		fingerprint = "fp-1"
	}
	status := o.Status
	if status == "" {
		status = "active"
	}
	iat := now - 10
	if o.Iat != nil {
		iat = *o.Iat
	}
	nbf := now - 10
	if o.Nbf != nil {
		nbf = *o.Nbf
	}
	exp := now + 3600
	if o.Exp != nil {
		exp = *o.Exp
	}

	backend := ed.New()
	pemMat, _, err := backend.Generate("")
	if err != nil {
		t.Fatalf("ed25519 generate: %v", err)
	}
	priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: pemMat}, "")
	if err != nil {
		t.Fatalf("import priv: %v", err)
	}

	const kid = "guard-test-kid"

	payload := lic.LIC1Payload{
		"jti":               "jti-1",
		"iat":               iat,
		"nbf":               nbf,
		"exp":               exp,
		"scope":             "default",
		"license_id":        "lic-1",
		"usage_id":          "use-1",
		"usage_fingerprint": fingerprint,
		"status":            status,
		"max_usages":        int64(1),
	}
	if o.ForceOnlineAfter != nil {
		payload["force_online_after"] = *o.ForceOnlineAfter
	}

	tok, err := lic.Encode(lic.EncodeOptions{
		Header: lic.LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: lic.AlgEd25519,
			Kid: kid,
		},
		Payload:    payload,
		PrivateKey: priv,
		Backend:    backend,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(backend); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind(kid, lic.AlgEd25519); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		kid: {
			Kid: kid,
			Alg: lic.AlgEd25519,
			Pem: lic.PemKeyMaterial{PublicPem: pemMat.PublicPem},
		},
	}

	return forgedToken{
		Token:    tok,
		Registry: reg,
		Bindings: bindings,
		Keys:     keys,
	}
}

// ---------- transport mocks ----------

// dialErrorTransport is an http.RoundTripper that fails every request,
// simulating an unreachable issuer (network error → IssuerUnreachable).
type dialErrorTransport struct{}

func (dialErrorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("simulated network error")
}

// unreachableHTTPClient returns an *http.Client whose RoundTripper always
// errors — drives client.Refresh into the IssuerUnreachable / grace path.
func unreachableHTTPClient() *http.Client {
	return &http.Client{Transport: dialErrorTransport{}}
}

// failOn500Server returns a server that always 500s with non-JSON body
// (also produces IssuerUnreachable via the transport's JSON-parse fallback).
func failOn500Server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
}

// ---------- helpers ----------

// setupGuardClient wires up an easy.Client with a memory store, the
// supplied forged token + verify config, and an unreachable transport by
// default. Override individual fields via setupOpts.
type setupOpts struct {
	HTTPClient     *http.Client
	GraceStartSec  *int64
	StoreToken     string // overrides forged.Token; "" means leave store empty
	NowSec         int64
	GracePeriodSec int64
	GracePeriodSet bool
	OmitVerify     bool
	UseForged      bool
}

func setupGuardClient(t *testing.T, forged forgedToken, opts setupOpts) (*easy.Client, *client.MemoryTokenStore) {
	t.Helper()
	store := client.NewMemoryTokenStore()
	if opts.UseForged || opts.StoreToken != "" {
		tok := forged.Token
		if opts.StoreToken != "" {
			tok = opts.StoreToken
		}
		_ = store.Write(client.StoredTokenState{
			Token:         tok,
			GraceStartSec: opts.GraceStartSec,
		})
	}

	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = unreachableHTTPClient()
	}
	transport := client.TransportOptions{Client: httpClient}

	cfg := easy.ClientConfig{
		ServerURL: "https://issuer.example",
		Storage:   store,
		Transport: transport,
		NowFunc:   func() int64 { return opts.NowSec },
	}
	if opts.GracePeriodSet {
		cfg.GracePeriodSec = opts.GracePeriodSec
		cfg.GracePeriodSet = true
	}
	if !opts.OmitVerify {
		cfg.Verify = &easy.ClientVerifyConfig{
			Registry: forged.Registry,
			Bindings: forged.Bindings,
			Keys:     forged.Keys,
		}
	}

	c, err := easy.NewClient(cfg)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c, store
}

// ---------- tests ----------

func TestGuard_NoTokenWhenStorageEmpty(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now})
	c, _ := setupGuardClient(t, f, setupOpts{NowSec: now})
	_, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if !errors.Is(err, client.ErrNoToken) {
		t.Fatalf("want ErrNoToken, got %v", err)
	}
}

func TestGuard_ReturnsHandleForValidActiveToken(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})
	c, _ := setupGuardClient(t, f, setupOpts{NowSec: now, UseForged: true})
	h, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if err != nil {
		t.Fatalf("guard: %v", err)
	}
	if h.LicenseID != "lic-1" {
		t.Fatalf("LicenseID: want lic-1, got %s", h.LicenseID)
	}
	if h.UsageID != "use-1" {
		t.Fatalf("UsageID: want use-1, got %s", h.UsageID)
	}
	if h.Status != "active" {
		t.Fatalf("Status: want active, got %s", h.Status)
	}
	if h.IsInGrace {
		t.Fatalf("IsInGrace should be false")
	}
	if h.GraceStartedAt != 0 {
		t.Fatalf("GraceStartedAt should be 0, got %d", h.GraceStartedAt)
	}
}

func TestGuard_TokenExpired(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})
	// Move clock far past exp + skew.
	c, _ := setupGuardClient(t, f, setupOpts{NowSec: now + 100_000, UseForged: true})
	_, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if !errors.Is(err, client.ErrTokenExpired) {
		t.Fatalf("want ErrTokenExpired, got %v", err)
	}
}

func TestGuard_FingerprintMismatch(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})
	c, _ := setupGuardClient(t, f, setupOpts{NowSec: now, UseForged: true})
	_, err := c.Guard(easy.ValidateInput{Fingerprint: "wrong-fingerprint"})
	if !errors.Is(err, client.ErrFingerprintMismatch) {
		t.Fatalf("want ErrFingerprintMismatch, got %v", err)
	}
}

func TestGuard_SurfacesGraceStateFromStore(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})
	graceStart := now - 86_400
	srv := failOn500Server(t)
	defer srv.Close()

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token, GraceStartSec: &graceStart})
	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
		GracePeriodSec: 7 * 86_400,
		GracePeriodSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if err != nil {
		t.Fatalf("guard: %v", err)
	}
	if !h.IsInGrace {
		t.Fatalf("IsInGrace should be true")
	}
	if h.GraceStartedAt != graceStart {
		t.Fatalf("GraceStartedAt: want %d, got %d", graceStart, h.GraceStartedAt)
	}
}

func TestGuard_GraceExpired(t *testing.T) {
	now := int64(2_000_000_000)
	foa := now - 100
	f := forgeToken(t, forgeOpts{
		NowSec:           now,
		UsageFingerprint: "fp-1",
		ForceOnlineAfter: &foa,
	})
	graceStart := now - (8 * 86_400) // 8 days ago, past 7-day window

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token, GraceStartSec: &graceStart})

	srv := failOn500Server(t)
	defer srv.Close()

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
		GracePeriodSec: 7 * 86_400,
		GracePeriodSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if !errors.Is(err, client.ErrGraceExpired) {
		t.Fatalf("want ErrGraceExpired, got %v", err)
	}
}

func TestGuard_RefreshNotDue_NoNetwork(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})

	// Counting transport — fails every request, but should never be called.
	calls := 0
	rt := roundTripperFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("network must not be touched")
	})
	httpClient := &http.Client{Transport: rt}

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: "https://issuer.example",
		Storage:   store,
		Transport: client.TransportOptions{Client: httpClient},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"}); err != nil {
		t.Fatalf("guard: %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected 0 network calls, got %d", calls)
	}
}

func TestGuard_VerifyConfigMissingError(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})
	c, _ := setupGuardClient(t, f, setupOpts{
		NowSec:     now,
		UseForged:  true,
		OmitVerify: true,
	})
	_, err := c.Guard(easy.ValidateInput{Fingerprint: "fp-1"})
	if err == nil || !strings.Contains(err.Error(), "verify config is required") {
		t.Fatalf("want verify-required error, got %v", err)
	}
}

func TestValidate_WorksWithoutInvokingNetwork(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeToken(t, forgeOpts{NowSec: now, UsageFingerprint: "fp-1"})

	calls := 0
	rt := roundTripperFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("network must not be touched")
	})
	httpClient := &http.Client{Transport: rt}

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: "https://issuer.example",
		Storage:   store,
		Transport: client.TransportOptions{Client: httpClient},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Validate(easy.ValidateInput{Fingerprint: "fp-1"})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.LicenseID != "lic-1" {
		t.Fatalf("LicenseID: want lic-1, got %s", res.LicenseID)
	}
	if calls != 0 {
		t.Fatalf("expected 0 network calls, got %d", calls)
	}
}

func TestHeartbeat_ReturnsScheduler(t *testing.T) {
	store := client.NewMemoryTokenStore()
	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: "https://issuer.example",
		Storage:   store,
	})
	if err != nil {
		t.Fatal(err)
	}
	hb := c.Heartbeat(easy.HeartbeatInput{
		IntervalSec: 60,
	})
	if hb == nil {
		t.Fatal("heartbeat returned nil")
	}
	// Stop is safe-when-not-started.
	hb.Stop()
}

// ---------- helper transport ----------

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
