package http

import (
	lic "github.com/AnoRebel/licensing/licensing"
)

// AdminContext bundles the dependencies the admin handlers need.
// Rotation and key-creation endpoints require the root and signing
// passphrases; they are supplied once here so the handler group wires
// them in rather than via request bodies (passphrases on the wire are
// a non-starter).
type AdminContext struct {
	Storage  lic.Storage
	Clock    lic.Clock
	Backends *lic.AlgorithmRegistry

	// Version is reported by /health if the admin surface re-exports it.
	Version string

	// RootPassphrase is used by POST /admin/keys (role=root) and by
	// POST /admin/keys/{id}/rotate (to re-attest the new signing key).
	// Leave empty to disable rotation / root key creation.
	RootPassphrase string

	// SigningPassphrase is used by POST /admin/keys (role=signing) and
	// POST /admin/keys/{id}/rotate. Leave empty to disable signing-key
	// issuance + rotation.
	SigningPassphrase string
}
