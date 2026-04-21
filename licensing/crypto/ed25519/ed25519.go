// Package ed25519 implements the licensing SignatureBackend for Ed25519.
//
// Uses the Go standard library (crypto/ed25519, crypto/x509, encoding/pem).
// No third-party curve library is pulled in — auditors only need to trust
// the Go runtime. Mirrors @licensing/core/crypto/ed25519 semantically:
//
//   - Accepts raw 32-byte seeds OR PKCS#8/SPKI PEM for key import
//   - Produces deterministic 64-byte signatures
//   - Generates plaintext PEM + raw keys; passphrase-based wrapping is the
//     key-hierarchy layer's responsibility, not this backend's
package ed25519

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// Byte lengths, mirroring the TS constants.
const (
	RawSeedLen   = ed25519.SeedSize      // 32
	RawPubLen    = ed25519.PublicKeySize // 32
	SignatureLen = ed25519.SignatureSize // 64
)

// Backend is the sole SignatureBackend for Ed25519. It's stateless; a
// single value can be registered and reused module-wide.
type Backend struct{}

// New returns a ready-to-register backend value. There is only one correct
// Ed25519 backend, so there's no configuration to pass.
func New() Backend { return Backend{} }

// Alg returns the algorithm identifier this backend handles.
func (Backend) Alg() lic.KeyAlg { return lic.AlgEd25519 }

// privateHandle wraps an Ed25519 private key. Keeping both the stdlib
// type and the raw seed lets us answer raw-bytes accessors without
// re-extracting from the key on every call.
type privateHandle struct {
	key  ed25519.PrivateKey
	seed []byte // 32 bytes — copy of the input seed
}

// publicHandle wraps an Ed25519 public key.
type publicHandle struct {
	key ed25519.PublicKey
	raw []byte // 32 bytes — canonical raw form
}

// ImportPrivate parses PEM or raw 32-byte seed into an opaque handle.
// Raw form takes priority when both fields are populated; PEM is tried
// as a fallback. passphrase is used only when decrypting an encrypted
// PKCS#8 PEM; raw seeds ignore it.
func (Backend) ImportPrivate(m lic.KeyMaterial, passphrase string) (lic.PrivateKeyHandle, error) {
	// Raw path.
	if len(m.Raw.PrivateRaw) > 0 {
		if len(m.Raw.PrivateRaw) != RawSeedLen {
			return nil, wrapStrength(fmt.Sprintf(
				"ed25519 seed must be %d bytes, got %d",
				RawSeedLen, len(m.Raw.PrivateRaw)))
		}
		seedCopy := make([]byte, RawSeedLen)
		copy(seedCopy, m.Raw.PrivateRaw)
		return &privateHandle{
			key:  ed25519.NewKeyFromSeed(seedCopy),
			seed: seedCopy,
		}, nil
	}
	// PEM path.
	if m.Pem.PrivatePem != "" {
		blk, _ := pem.Decode([]byte(m.Pem.PrivatePem))
		if blk == nil {
			return nil, wrapMalformed("ed25519: invalid PEM envelope")
		}
		// Encrypted PKCS#8 (PBES2) decryption happens in the key-hierarchy
		// layer, not here. If we see an encrypted header we expect it to
		// have been unwrapped already.
		if blk.Type != "PRIVATE KEY" {
			return nil, wrapMalformed(fmt.Sprintf(
				"ed25519: expected PEM type \"PRIVATE KEY\", got %q", blk.Type))
		}
		keyAny, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, wrapDecryptFailed()
		}
		priv, ok := keyAny.(ed25519.PrivateKey)
		if !ok {
			return nil, wrapMalformed(fmt.Sprintf(
				"ed25519: PKCS#8 key is %T, not ed25519.PrivateKey", keyAny))
		}
		seed := priv.Seed()
		seedCopy := make([]byte, RawSeedLen)
		copy(seedCopy, seed)
		return &privateHandle{key: priv, seed: seedCopy}, nil
	}
	return nil, wrapMalformed("ed25519: neither Raw.PrivateRaw nor Pem.PrivatePem provided")
}

// ImportPublic parses raw 32-byte public key or SPKI PEM.
func (Backend) ImportPublic(m lic.KeyMaterial) (lic.PublicKeyHandle, error) {
	if len(m.Raw.PublicRaw) > 0 {
		if len(m.Raw.PublicRaw) != RawPubLen {
			return nil, wrapStrength(fmt.Sprintf(
				"ed25519 public key must be %d bytes, got %d",
				RawPubLen, len(m.Raw.PublicRaw)))
		}
		rawCopy := make([]byte, RawPubLen)
		copy(rawCopy, m.Raw.PublicRaw)
		return &publicHandle{key: ed25519.PublicKey(rawCopy), raw: rawCopy}, nil
	}
	if m.Pem.PublicPem != "" {
		blk, _ := pem.Decode([]byte(m.Pem.PublicPem))
		if blk == nil {
			return nil, wrapMalformed("ed25519: invalid PEM envelope")
		}
		if blk.Type != "PUBLIC KEY" {
			return nil, wrapMalformed(fmt.Sprintf(
				"ed25519: expected PEM type \"PUBLIC KEY\", got %q", blk.Type))
		}
		keyAny, err := x509.ParsePKIXPublicKey(blk.Bytes)
		if err != nil {
			return nil, wrapMalformed("ed25519: SPKI parse failed: " + err.Error())
		}
		pub, ok := keyAny.(ed25519.PublicKey)
		if !ok {
			return nil, wrapMalformed(fmt.Sprintf(
				"ed25519: SPKI key is %T, not ed25519.PublicKey", keyAny))
		}
		rawCopy := make([]byte, RawPubLen)
		copy(rawCopy, pub)
		return &publicHandle{key: pub, raw: rawCopy}, nil
	}
	return nil, wrapMalformed("ed25519: neither Raw.PublicRaw nor Pem.PublicPem provided")
}

// Sign returns a 64-byte Ed25519 signature over data.
func (Backend) Sign(h lic.PrivateKeyHandle, data []byte) ([]byte, error) {
	ph, ok := h.(*privateHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"ed25519.Sign: wrong handle type %T", h))
	}
	sig := ed25519.Sign(ph.key, data)
	if len(sig) != SignatureLen {
		// Can't happen with stdlib, but if the invariant ever breaks we
		// refuse to return a malformed signature.
		return nil, wrapSignatureInvalid()
	}
	return sig, nil
}

// Verify returns (true, nil) iff sig is a valid Ed25519 signature for data
// under the public key in h. A structurally bad signature returns
// (false, nil) rather than an error, matching the TS contract.
func (Backend) Verify(h lic.PublicKeyHandle, data, sig []byte) (bool, error) {
	ph, ok := h.(*publicHandle)
	if !ok {
		return false, wrapMalformed(fmt.Sprintf(
			"ed25519.Verify: wrong handle type %T", h))
	}
	if len(sig) != SignatureLen {
		return false, nil
	}
	return ed25519.Verify(ph.key, data, sig), nil
}

// Generate produces a fresh Ed25519 keypair with plaintext PEM + raw
// bytes. The passphrase argument is ignored — wrapping is done in the
// key-hierarchy layer.
func (Backend) Generate(_ string) (lic.PemKeyMaterial, lic.RawKeyMaterial, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	spki, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	privPem := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	pubPem := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki}))

	seed := priv.Seed()
	seedCopy := make([]byte, RawSeedLen)
	copy(seedCopy, seed)
	pubCopy := make([]byte, RawPubLen)
	copy(pubCopy, pub)

	return lic.PemKeyMaterial{PrivatePem: privPem, PublicPem: pubPem},
		lic.RawKeyMaterial{PrivateRaw: seedCopy, PublicRaw: pubCopy},
		nil
}

// -----------------------------------------------------------------------
// Raw-bytes accessors.
//
// These let callers round-trip a stored key from its PEM export back into
// raw seed / public bytes, which is useful for clients that want the
// smallest possible embedded trust anchor.
// -----------------------------------------------------------------------

// PrivateSeed returns a copy of the 32-byte seed for an Ed25519 private
// handle produced by ImportPrivate or Generate. The copy means callers
// can zero the returned slice without affecting the handle's key.
func PrivateSeed(h lic.PrivateKeyHandle) ([]byte, error) {
	ph, ok := h.(*privateHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"ed25519.PrivateSeed: wrong handle type %T", h))
	}
	out := make([]byte, RawSeedLen)
	copy(out, ph.seed)
	return out, nil
}

// PublicRaw returns a copy of the 32-byte public key for an Ed25519
// public handle.
func PublicRaw(h lic.PublicKeyHandle) ([]byte, error) {
	ph, ok := h.(*publicHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"ed25519.PublicRaw: wrong handle type %T", h))
	}
	out := make([]byte, RawPubLen)
	copy(out, ph.raw)
	return out, nil
}

// Compile-time assertion that Backend implements SignatureBackend.
var _ lic.SignatureBackend = Backend{}

// -----------------------------------------------------------------------
// Error helpers — these wrap the parent module's sentinels. We can't
// construct licensing.Error directly because its Code field is exported
// but the newError factory isn't. `errors.New` + sentinel comparison via
// errors.Is is the stable contract.
// -----------------------------------------------------------------------

func wrapStrength(msg string) error {
	return fmt.Errorf("%w: %s", lic.ErrInsufficientKeyStrength, msg)
}

func wrapMalformed(msg string) error {
	return fmt.Errorf("%w: %s", lic.ErrTokenMalformed, msg)
}

func wrapDecryptFailed() error {
	return fmt.Errorf("%w", lic.ErrKeyDecryptionFailed)
}

func wrapSignatureInvalid() error {
	return fmt.Errorf("%w", lic.ErrTokenSignatureInvalid)
}
