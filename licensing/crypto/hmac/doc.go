// Package hmac implements the SignatureBackend for HMAC-SHA256 using the Go
// standard library (crypto/hmac, crypto/sha256).
//
// Mirrors @licensing/core/crypto/hmac. Secrets shorter than 32 bytes are
// rejected with ErrInsufficientKeyStrength. Verification uses constant-time
// comparison (hmac.Equal).
package hmac
