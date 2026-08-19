package http

import (
	lic "github.com/AnoRebel/licensing/licensing"
)

// ClientContext bundles the dependencies the client-facing handlers need.
// Callers construct one at process start and pass it to NewClientHandler.
type ClientContext struct {
	Storage          lic.Storage
	Clock            lic.Clock
	Backends         *lic.AlgorithmRegistry
	ForceOnlineAfter *int64
	// TransparencyHook, when non-nil, fires after every successful token
	// issue (activate / refresh / heartbeat-rollover paths). The hook
	// receives jti + sha256(token) + identifying metadata; operators MAY
	// mirror this to an externally-verifiable append-only store
	// (S3 with object lock, AWS QLDB, immudb, a managed CT-style log)
	// so a stolen-key attacker who mints tokens cannot do so without
	// leaving a trail on the operator's transparency vendor.
	//
	// Fire-and-forget: any retry / async / error-surfacing concern lives
	// in the operator's wrapper. Hook failures do NOT fail the issuance.
	TransparencyHook  lic.TransparencyHook
	DefaultAlg        lic.KeyAlg
	SigningPassphrase string
	Version           string
	// TokenFormat selects the envelope to issue. Zero value means LIC1.
	//
	// FormatLIC2 emits PASETO v4.public and supports Ed25519 only, so
	// pairing it with a non-Ed25519 DefaultAlg is rejected. Verification
	// accepts both formats regardless of this setting, so an operator can
	// switch issuance without invalidating tokens already in the field.
	TokenFormat lic.TokenFormat
	TokenTTLSec int
}

// tokenFormat returns the configured envelope, defaulting to LIC1.
func (c *ClientContext) tokenFormat() lic.TokenFormat {
	if c.TokenFormat != "" {
		return c.TokenFormat
	}
	return lic.FormatLIC1
}

func (c *ClientContext) alg() lic.KeyAlg {
	if c.DefaultAlg != "" {
		return c.DefaultAlg
	}
	return lic.AlgEd25519
}

func (c *ClientContext) ttl() int {
	if c.TokenTTLSec > 0 {
		return c.TokenTTLSec
	}
	return 3600
}
