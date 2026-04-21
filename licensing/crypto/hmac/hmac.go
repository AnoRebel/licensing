// Package hmac implements the licensing SignatureBackend for HMAC-SHA-256.
//
// Uses only the Go standard library (crypto/hmac, crypto/sha256).
// Mirrors @licensing/core/crypto/hmac semantically:
//
//   - Secrets must be at least 32 bytes; shorter secrets are rejected with
//     ErrInsufficientKeyStrength
//   - MAC is 32 bytes (SHA-256 output)
//   - Verification uses hmac.Equal (constant-time) — never bytes.Equal
//
// Caveats (documented for operators — same text as the TS sibling):
//
//   - HMAC is SYMMETRIC. The "public" key is the same secret as the
//     "private" key. Distributing the secret to multiple verifiers means
//     each verifier can also forge tokens. Use only in self-contained
//     deployments where issuer and verifier are the same trust boundary.
//   - PEM is not a natural representation for HMAC; this backend accepts
//     raw bytes only. The PEM input path is rejected with a clear error
//     so operators can't accidentally wire a PEM key into HMAC.
package hmac

import (
	stdhmac "crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// Profile parameters — must match @licensing/core/crypto/hmac.ts.
const (
	MinSecretLen     = 32
	DefaultSecretLen = 32
	SignatureLen     = 32 // = SHA-256 output
)

// Backend is the sole SignatureBackend for HMAC-SHA-256. Stateless.
type Backend struct{}

// New returns a ready-to-register backend value.
func New() Backend { return Backend{} }

// Alg returns the algorithm identifier this backend handles.
func (Backend) Alg() lic.KeyAlg { return lic.AlgHS256 }

// handle holds the shared secret. Since HMAC is symmetric, both
// PrivateKeyHandle and PublicKeyHandle are backed by the same struct.
type handle struct {
	secret []byte
}

// ImportPrivate loads a secret from raw bytes. PEM input is explicitly
// rejected — there is no natural PEM representation for an HMAC secret.
func (Backend) ImportPrivate(m lic.KeyMaterial, _ string) (lic.PrivateKeyHandle, error) {
	if m.Pem.PrivatePem != "" || m.Pem.PublicPem != "" {
		return nil, wrapMalformed("hmac does not support PEM material — pass raw bytes")
	}
	// Prefer PrivateRaw; fall back to PublicRaw since they're the same secret.
	secret := m.Raw.PrivateRaw
	if len(secret) == 0 {
		secret = m.Raw.PublicRaw
	}
	if len(secret) == 0 {
		return nil, wrapMalformed("hmac: raw secret not provided")
	}
	if len(secret) < MinSecretLen {
		return nil, wrapStrength(fmt.Sprintf(
			"HMAC secret must be ≥ %d bytes, got %d", MinSecretLen, len(secret)))
	}
	cp := make([]byte, len(secret))
	copy(cp, secret)
	return &handle{secret: cp}, nil
}

// ImportPublic mirrors ImportPrivate for the symmetric case.
func (Backend) ImportPublic(m lic.KeyMaterial) (lic.PublicKeyHandle, error) {
	if m.Pem.PrivatePem != "" || m.Pem.PublicPem != "" {
		return nil, wrapMalformed("hmac does not support PEM material — pass raw bytes")
	}
	secret := m.Raw.PublicRaw
	if len(secret) == 0 {
		secret = m.Raw.PrivateRaw
	}
	if len(secret) == 0 {
		return nil, wrapMalformed("hmac: raw secret not provided")
	}
	if len(secret) < MinSecretLen {
		return nil, wrapStrength(fmt.Sprintf(
			"HMAC secret must be ≥ %d bytes, got %d", MinSecretLen, len(secret)))
	}
	cp := make([]byte, len(secret))
	copy(cp, secret)
	return &handle{secret: cp}, nil
}

// Sign returns the 32-byte HMAC-SHA-256 of data under the handle's secret.
func (Backend) Sign(h lic.PrivateKeyHandle, data []byte) ([]byte, error) {
	hh, ok := h.(*handle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"hmac.Sign: wrong handle type %T", h))
	}
	m := stdhmac.New(sha256.New, hh.secret)
	m.Write(data)
	return m.Sum(nil), nil
}

// Verify returns (true, nil) iff sig matches the expected HMAC of data under
// the handle's secret. A structurally wrong-length sig returns (false, nil)
// without touching the secret material. Comparison is constant-time.
func (Backend) Verify(h lic.PublicKeyHandle, data, sig []byte) (bool, error) {
	hh, ok := h.(*handle)
	if !ok {
		return false, wrapMalformed(fmt.Sprintf(
			"hmac.Verify: wrong handle type %T", h))
	}
	if len(sig) != SignatureLen {
		return false, nil
	}
	m := stdhmac.New(sha256.New, hh.secret)
	m.Write(data)
	expected := m.Sum(nil)
	return stdhmac.Equal(expected, sig), nil
}

// Generate produces a fresh random 32-byte secret. The returned PemKeyMaterial
// is empty because HMAC has no natural PEM form; callers consume the raw
// bytes.
func (Backend) Generate(_ string) (lic.PemKeyMaterial, lic.RawKeyMaterial, error) {
	secret := make([]byte, DefaultSecretLen)
	if _, err := rand.Read(secret); err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	// Both halves point at copies of the same secret so consumers who reach
	// for PrivateRaw or PublicRaw both work, and mutating one doesn't corrupt
	// the other.
	privCopy := make([]byte, DefaultSecretLen)
	pubCopy := make([]byte, DefaultSecretLen)
	copy(privCopy, secret)
	copy(pubCopy, secret)
	return lic.PemKeyMaterial{},
		lic.RawKeyMaterial{PrivateRaw: privCopy, PublicRaw: pubCopy},
		nil
}

// -----------------------------------------------------------------------
// Raw-bytes accessor.
// -----------------------------------------------------------------------

// Secret returns a copy of the raw secret bytes held by a handle.
func Secret(h any) ([]byte, error) {
	hh, ok := h.(*handle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"hmac.Secret: wrong handle type %T", h))
	}
	out := make([]byte, len(hh.secret))
	copy(out, hh.secret)
	return out, nil
}

// Compile-time assertion.
var _ lic.SignatureBackend = Backend{}

// -----------------------------------------------------------------------
// Error wrappers — same pattern as the ed25519 / rsa backends.
// -----------------------------------------------------------------------

func wrapStrength(msg string) error {
	return fmt.Errorf("%w: %s", lic.ErrInsufficientKeyStrength, msg)
}

func wrapMalformed(msg string) error {
	return fmt.Errorf("%w: %s", lic.ErrTokenMalformed, msg)
}
