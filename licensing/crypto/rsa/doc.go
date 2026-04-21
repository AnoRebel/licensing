// Package rsa implements the SignatureBackend for RSASSA-PSS with SHA-256
// using the Go standard library (crypto/rsa).
//
// Mirrors @licensing/core/crypto/rsa. Keys smaller than 2048 bits are
// rejected with ErrInsufficientKeyStrength. Signatures use MGF1 with SHA-256
// and an equal-to-hash-length salt, exactly matching the TypeScript backend.
package rsa
