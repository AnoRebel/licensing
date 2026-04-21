// Package ed25519 implements the SignatureBackend for Ed25519 using the Go
// standard library (crypto/ed25519).
//
// Mirrors @licensing/core/crypto/ed25519: deterministic signatures, 32-byte
// seeds, 64-byte public keys, 64-byte signatures. Ed25519 is the default alg
// for LIC1 tokens.
package ed25519
