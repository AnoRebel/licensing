// Package rsa implements the licensing SignatureBackend for RSASSA-PSS with
// SHA-256 digest, MGF1(SHA-256), and salt length 32 bytes (equal to the hash
// output length).
//
// Uses only the Go standard library (crypto/rsa, crypto/x509, encoding/pem).
// Mirrors @anorebel/licensing/crypto/rsa semantically:
//
//   - Accepts PKCS#8 PEM (plaintext) or raw DER (PKCS#8) for private keys
//   - Accepts SPKI PEM or raw SPKI DER for public keys
//   - Enforces a 2048-bit modulus floor; default generate size is 3072
//   - Deterministic on the verify side (PSS sig length == modulus length)
//
// Encrypted-at-rest PEM wrapping is the key-hierarchy layer's responsibility,
// not this backend's.
package rsa

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"

	lic "github.com/AnoRebel/licensing/licensing"
)

// Profile parameters — these MUST match @anorebel/licensing/crypto/rsa.ts exactly
// or cross-language verification will fail silently.
const (
	MinBits     = 2048
	DefaultBits = 3072
	PSSSaltLen  = 32 // = SHA-256 output length; matches TS `saltLength: 32`
)

var pssOptions = &rsa.PSSOptions{
	SaltLength: PSSSaltLen,
	Hash:       crypto.SHA256,
}

// Backend is the sole SignatureBackend for RSA-PSS. Stateless.
type Backend struct{}

// New returns a ready-to-register backend value.
func New() Backend { return Backend{} }

// Alg returns the algorithm identifier this backend handles.
func (Backend) Alg() lic.KeyAlg { return lic.AlgRSAPSS }

// privateHandle wraps an *rsa.PrivateKey plus the PKCS#8 DER bytes so callers
// that want the raw material back don't have to re-marshal.
type privateHandle struct {
	key *rsa.PrivateKey
	der []byte // PKCS#8 DER
}

// publicHandle wraps an *rsa.PublicKey plus its SPKI DER.
type publicHandle struct {
	key *rsa.PublicKey
	der []byte // SPKI DER
}

// ImportPrivate parses PKCS#8 PEM or raw PKCS#8 DER into an opaque handle.
// Raw takes priority when both fields are populated. `passphrase` is unused
// here — encrypted PKCS#8 is unwrapped by the key-hierarchy layer before
// reaching this backend.
func (Backend) ImportPrivate(m lic.KeyMaterial, _ string) (lic.PrivateKeyHandle, error) {
	// Raw DER path.
	if len(m.Raw.PrivateRaw) > 0 {
		return importPrivateDER(m.Raw.PrivateRaw)
	}
	// PEM path.
	if m.Pem.PrivatePem != "" {
		blk, _ := pem.Decode([]byte(m.Pem.PrivatePem))
		if blk == nil {
			return nil, wrapMalformed("rsa: invalid PEM envelope")
		}
		if blk.Type != "PRIVATE KEY" {
			return nil, wrapMalformed(fmt.Sprintf(
				"rsa: expected PEM type \"PRIVATE KEY\", got %q", blk.Type))
		}
		return importPrivateDER(blk.Bytes)
	}
	return nil, wrapMalformed("rsa: neither Raw.PrivateRaw nor Pem.PrivatePem provided")
}

func importPrivateDER(der []byte) (lic.PrivateKeyHandle, error) {
	keyAny, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, wrapDecryptFailed()
	}
	priv, ok := keyAny.(*rsa.PrivateKey)
	if !ok {
		return nil, wrapStrength(fmt.Sprintf(
			"rsa: PKCS#8 key is %T, not *rsa.PrivateKey", keyAny))
	}
	if priv.N.BitLen() < MinBits {
		return nil, wrapStrength(fmt.Sprintf(
			"rsa: modulus %d bits < required %d", priv.N.BitLen(), MinBits))
	}
	derCopy := make([]byte, len(der))
	copy(derCopy, der)
	return &privateHandle{key: priv, der: derCopy}, nil
}

// ImportPublic parses SPKI PEM or raw SPKI DER.
func (Backend) ImportPublic(m lic.KeyMaterial) (lic.PublicKeyHandle, error) {
	if len(m.Raw.PublicRaw) > 0 {
		return importPublicDER(m.Raw.PublicRaw)
	}
	if m.Pem.PublicPem != "" {
		blk, _ := pem.Decode([]byte(m.Pem.PublicPem))
		if blk == nil {
			return nil, wrapMalformed("rsa: invalid PEM envelope")
		}
		if blk.Type != "PUBLIC KEY" {
			return nil, wrapMalformed(fmt.Sprintf(
				"rsa: expected PEM type \"PUBLIC KEY\", got %q", blk.Type))
		}
		return importPublicDER(blk.Bytes)
	}
	return nil, wrapMalformed("rsa: neither Raw.PublicRaw nor Pem.PublicPem provided")
}

func importPublicDER(der []byte) (lic.PublicKeyHandle, error) {
	keyAny, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, wrapMalformed("rsa: SPKI parse failed: " + err.Error())
	}
	pub, ok := keyAny.(*rsa.PublicKey)
	if !ok {
		return nil, wrapStrength(fmt.Sprintf(
			"rsa: SPKI key is %T, not *rsa.PublicKey", keyAny))
	}
	if pub.N.BitLen() < MinBits {
		return nil, wrapStrength(fmt.Sprintf(
			"rsa: modulus %d bits < required %d", pub.N.BitLen(), MinBits))
	}
	derCopy := make([]byte, len(der))
	copy(derCopy, der)
	return &publicHandle{key: pub, der: derCopy}, nil
}

// Sign returns an RSASSA-PSS signature over data. The input is hashed with
// SHA-256 before signing, matching Node's `sign('sha256', data, …)`.
func (Backend) Sign(h lic.PrivateKeyHandle, data []byte) ([]byte, error) {
	ph, ok := h.(*privateHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"rsa.Sign: wrong handle type %T", h))
	}
	digest := sha256.Sum256(data)
	sig, err := rsa.SignPSS(rand.Reader, ph.key, crypto.SHA256, digest[:], pssOptions)
	if err != nil {
		return nil, wrapSignatureInvalid()
	}
	return sig, nil
}

// Verify returns (true, nil) iff sig is a valid RSA-PSS signature over data
// under the key in h. A structurally bad signature (wrong length, bad
// padding, bad digest) returns (false, nil) — matching the TS contract that
// surfaces ErrTokenSignatureInvalid at the Verify() layer, not here.
func (Backend) Verify(h lic.PublicKeyHandle, data, sig []byte) (bool, error) {
	ph, ok := h.(*publicHandle)
	if !ok {
		return false, wrapMalformed(fmt.Sprintf(
			"rsa.Verify: wrong handle type %T", h))
	}
	// Cheap pre-check: PSS signature length always equals the modulus size
	// in bytes. Save a full verify op on obviously malformed input.
	if len(sig) != (ph.key.N.BitLen()+7)/8 {
		return false, nil
	}
	digest := sha256.Sum256(data)
	if err := rsa.VerifyPSS(ph.key, crypto.SHA256, digest[:], sig, pssOptions); err != nil {
		return false, nil
	}
	return true, nil
}

// Generate produces a fresh 3072-bit RSA keypair with plaintext PKCS#8 PEM
// plus raw DER for both halves. `passphrase` is ignored here; encryption is
// a separate layer.
func (Backend) Generate(_ string) (lic.PemKeyMaterial, lic.RawKeyMaterial, error) {
	priv, err := rsa.GenerateKey(rand.Reader, DefaultBits)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	spki, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, err
	}
	privPem := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	pubPem := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki}))

	privDer := make([]byte, len(pkcs8))
	copy(privDer, pkcs8)
	pubDer := make([]byte, len(spki))
	copy(pubDer, spki)

	return lic.PemKeyMaterial{PrivatePem: privPem, PublicPem: pubPem},
		lic.RawKeyMaterial{PrivateRaw: privDer, PublicRaw: pubDer},
		nil
}

// -----------------------------------------------------------------------
// Raw-bytes accessors. Expose the DER bytes held by each handle, copied
// so callers can't mutate backend-internal state.
// -----------------------------------------------------------------------

// PrivateDER returns a copy of the PKCS#8 DER for a handle produced by
// ImportPrivate or Generate.
func PrivateDER(h lic.PrivateKeyHandle) ([]byte, error) {
	ph, ok := h.(*privateHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"rsa.PrivateDER: wrong handle type %T", h))
	}
	out := make([]byte, len(ph.der))
	copy(out, ph.der)
	return out, nil
}

// PublicDER returns a copy of the SPKI DER for a public handle.
func PublicDER(h lic.PublicKeyHandle) ([]byte, error) {
	ph, ok := h.(*publicHandle)
	if !ok {
		return nil, wrapMalformed(fmt.Sprintf(
			"rsa.PublicDER: wrong handle type %T", h))
	}
	out := make([]byte, len(ph.der))
	copy(out, ph.der)
	return out, nil
}

// Compile-time assertion.
var _ lic.SignatureBackend = Backend{}

// -----------------------------------------------------------------------
// Error wrappers — same pattern as the ed25519 backend.
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
