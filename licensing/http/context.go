package http

import (
	lic "github.com/AnoRebel/licensing/licensing"
)

// ClientContext bundles the dependencies the client-facing handlers need.
// Callers construct one at process start and pass it to NewClientHandler.
type ClientContext struct {
	Storage           lic.Storage
	Clock             lic.Clock
	Backends          *lic.AlgorithmRegistry
	ForceOnlineAfter  *int64
	DefaultAlg        lic.KeyAlg
	SigningPassphrase string
	Version           string
	TokenTTLSec       int
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
