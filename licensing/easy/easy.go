// Package easy provides a high-level facade for the licensing toolkit —
// the Go counterpart of typescript/src/easy.ts.
//
// The primitive layer (lic.AlgorithmRegistry, lic.KeyHierarchy, the storage
// adapters, and the discrete *_service helpers) gives you full control. The
// easy package gives you a 5-line quickstart for the 80% case:
//
//	storage := memory.New(memory.Options{})
//	issuer, err := easy.NewIssuer(easy.IssuerConfig{
//	    DB:      storage,
//	    Signing: &easy.SigningConfig{Passphrase: passphrase},
//	})
//	if err != nil { … }
//	license, err := issuer.Issue(ctx, easy.IssueInput{
//	    LicensableType: "User",
//	    LicensableID:   "u_123",
//	    MaxUsages:      5,
//	})
//
// Defaults:
//
//   - Algorithm: ed25519 (the only one wired by default; pass Backends to
//     override).
//   - Clock: lic.SystemClock{}.
//   - Default actor for audit rows: "system".
//   - Default scope: nil (global).
//
// The factory is async-shaped (returns an error) because key auto-generation
// runs at construction time when SigningConfig is provided.
package easy

import (
	"context"
	"errors"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
	ed25519backend "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// SigningConfig controls signing-key auto-generation.
type SigningConfig struct {
	// Algorithm. Defaults to "ed25519" — the only backend wired by default.
	Algorithm lic.KeyAlg
	// Required for auto-generation: passphrase used to encrypt the PKCS8
	// private key blob. Pulled from secret manager / env in real deployments.
	Passphrase string
}

// IssuerConfig configures NewIssuer.
type IssuerConfig struct {
	// Clock injection (testing). Defaults to lic.SystemClock{}.
	Clock lic.Clock
	// Storage adapter. Required.
	DB lic.Storage
	// Signing configuration. When nil, the issuer fails on first key-requiring
	// operation if storage has no active signing key. When provided, missing
	// keys are auto-generated on first use.
	Signing *SigningConfig
	// Algorithm registry override. Default registers ed25519 only.
	Backends *lic.AlgorithmRegistry
	// Default scope id for issuance. nil = global scope.
	DefaultScopeID *string
	// Default actor for audit-log rows when callers don't provide one. Default "system".
	DefaultActor string
}

// IssueInput is the caller-supplied shape for Issuer.Issue.
type IssueInput struct {
	Meta map[string]any
	// Optional template id; resolves entitlements/duration/etc.
	TemplateID     *string
	ScopeID        *string
	ExpiresAt      *string
	GraceUntil     *string
	LicensableType string
	LicensableID   string
	// Optional override; auto-generated when empty.
	LicenseKey string
	// Lifecycle status. Default LicenseStatusPending.
	Status lic.LicenseStatus
	// Audit actor. Defaults to the issuer's DefaultActor or "system".
	Actor      string
	MaxUsages  int
	ScopeIDSet bool
}

// IssuedLicense is the returned shape from Issuer.Issue.
type IssuedLicense struct {
	*lic.License
	LicenseKey string
}

// Issuer wraps the primitive services with sensible defaults.
type Issuer struct {
	clock          lic.Clock
	db             lic.Storage
	backends       *lic.AlgorithmRegistry
	signing        *SigningConfig
	defaultScopeID *string
	// Cached active signing key (populated by ensureSigningKey).
	signingKey   *lic.LicenseKey
	defaultActor string
}

// NewIssuer constructs a high-level issuer. When SigningConfig is provided,
// it eagerly resolves an active signing key — auto-generating root + signing
// pair if storage has none. This surfaces missing-passphrase / missing-key
// errors at construction rather than first issuance.
func NewIssuer(config IssuerConfig) (*Issuer, error) {
	if config.DB == nil {
		return nil, errors.New("easy.NewIssuer: DB is required")
	}
	clock := config.Clock
	if clock == nil {
		clock = lic.SystemClock{}
	}
	backends := config.Backends
	if backends == nil {
		backends = defaultBackends()
	}
	defaultActor := config.DefaultActor
	if defaultActor == "" {
		defaultActor = "system"
	}
	issuer := &Issuer{
		db:             config.DB,
		clock:          clock,
		backends:       backends,
		signing:        config.Signing,
		defaultActor:   defaultActor,
		defaultScopeID: config.DefaultScopeID,
	}
	if config.Signing != nil {
		if _, err := issuer.EnsureSigningKey(); err != nil {
			return nil, err
		}
	}
	return issuer, nil
}

// defaultBackends returns a registry pre-populated with ed25519.
func defaultBackends() *lic.AlgorithmRegistry {
	r := lic.NewAlgorithmRegistry()
	_ = r.Register(ed25519backend.New())
	return r
}

// Storage returns the underlying adapter for power users.
func (i *Issuer) Storage() lic.Storage { return i.db }

// Issue creates a license. Persists the row + writes a license.created audit
// entry inside one transaction. The LicenseKey is generated when the caller
// omits it.
func (i *Issuer) Issue(_ context.Context, input IssueInput) (*IssuedLicense, error) {
	scopeID := input.ScopeID
	if !input.ScopeIDSet {
		scopeID = i.defaultScopeID
	}
	actor := input.Actor
	if actor == "" {
		actor = i.defaultActor
	}
	createInput := lic.CreateLicenseInput{
		ScopeID:        scopeID,
		TemplateID:     input.TemplateID,
		LicensableType: input.LicensableType,
		LicensableID:   input.LicensableID,
		LicenseKey:     input.LicenseKey,
		Status:         input.Status,
		MaxUsages:      input.MaxUsages,
		ExpiresAt:      input.ExpiresAt,
		GraceUntil:     input.GraceUntil,
		Meta:           input.Meta,
	}
	license, err := lic.CreateLicense(i.db, i.clock, createInput, lic.CreateLicenseOptions{
		Actor: actor,
	})
	if err != nil {
		return nil, err
	}
	return &IssuedLicense{License: license, LicenseKey: license.LicenseKey}, nil
}

// EnsureSigningKey returns the active signing key for the configured algorithm
// and scope. When SigningConfig is set and storage has none, auto-generates
// a fresh root + signing pair. Subsequent calls return the cached value.
func (i *Issuer) EnsureSigningKey() (*lic.LicenseKey, error) {
	if i.signingKey != nil {
		return i.signingKey, nil
	}
	alg := lic.KeyAlg("ed25519")
	if i.signing != nil && i.signing.Algorithm != "" {
		alg = i.signing.Algorithm
	}
	filter := lic.LicenseKeyFilter{
		Role:  ptrKeyRole(lic.RoleSigning),
		State: ptrKeyState(lic.StateActive),
		Alg:   ptrKeyAlg(alg),
	}
	if i.defaultScopeID != nil {
		filter.ScopeID = i.defaultScopeID
		filter.ScopeIDSet = true
	}
	page, err := i.db.ListKeys(filter, lic.PageRequest{Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(page.Items) > 0 {
		k := page.Items[0]
		i.signingKey = &k
		return i.signingKey, nil
	}
	if i.signing == nil {
		return nil, errors.New(
			"easy: no active signing key found and no Signing config provided — pass " +
				"&easy.SigningConfig{Passphrase: ...} to auto-generate keys, or supply your own",
		)
	}
	return i.autoGenerateSigningKey(alg, i.signing.Passphrase)
}

func (i *Issuer) autoGenerateSigningKey(alg lic.KeyAlg, passphrase string) (*lic.LicenseKey, error) {
	keyOpts := lic.KeyIssueOptions{Actor: i.defaultActor}
	root, err := lic.GenerateRootKey(i.db, i.clock, i.backends, lic.GenerateRootKeyInput{
		ScopeID:    i.defaultScopeID,
		Alg:        alg,
		Passphrase: passphrase,
	}, keyOpts)
	if err != nil {
		return nil, fmt.Errorf("auto-generate root key: %w", err)
	}
	signing, err := lic.IssueInitialSigningKey(i.db, i.clock, i.backends, lic.IssueInitialSigningKeyInput{
		ScopeID:           i.defaultScopeID,
		Alg:               alg,
		RootKid:           root.Kid,
		RootPassphrase:    passphrase,
		SigningPassphrase: passphrase,
	}, keyOpts)
	if err != nil {
		return nil, fmt.Errorf("auto-generate signing key: %w", err)
	}
	i.signingKey = signing
	return signing, nil
}

// ---------- Helpers ----------

func ptrKeyRole(v lic.KeyRole) *lic.KeyRole    { return &v }
func ptrKeyState(v lic.KeyState) *lic.KeyState { return &v }
func ptrKeyAlg(v lic.KeyAlg) *lic.KeyAlg       { return &v }
