package licensing

import (
	"fmt"
	"sync"
)

// RawKeyMaterial carries the raw bytes for a key, in the representation
// canonical for its algorithm.
//
//   - Ed25519: PrivateRaw is the 32-byte seed (NOT the 64-byte expanded
//     form, NOT PKCS#8). PublicRaw is 32 bytes.
//   - RSA: PrivateRaw is RFC 8017 DER; PublicRaw is the DER of the inner
//     SubjectPublicKeyInfo BIT STRING.
//   - HMAC: PrivateRaw and PublicRaw are both the same raw secret bytes.
//
// PrivateRaw is nil when the adapter holds only the public half.
type RawKeyMaterial struct {
	PrivateRaw []byte
	PublicRaw  []byte
}

// PemKeyMaterial carries PEM-encoded key material. Private keys are in
// encrypted PKCS#8 form; public keys are SPKI.
type PemKeyMaterial struct {
	PrivatePem string // may be "" when only the public half is held
	PublicPem  string
}

// KeyRecord is a storage adapter's view of one (kid, alg) binding.
type KeyRecord struct {
	Kid string
	Alg KeyAlg
	Pem PemKeyMaterial
	Raw RawKeyMaterial
}

// KeyMaterial is the union of PEM and raw forms that backend importers
// accept. Exactly one of Pem.PrivatePem / Raw.PrivateRaw may be populated
// for private-key imports; for public imports, Pem.PublicPem or Raw.PublicRaw.
type KeyMaterial struct {
	Pem PemKeyMaterial
	Raw RawKeyMaterial
}

// PrivateKeyHandle is a backend-opaque private key handle. Callers obtain
// it from ImportPrivate and feed it back into Sign; the core never inspects it.
type PrivateKeyHandle any

// PublicKeyHandle is a backend-opaque public key handle. Callers obtain it
// from ImportPublic and feed it back into Verify; the core never inspects it.
type PublicKeyHandle any

// Signer produces signatures for a specific algorithm.
type Signer interface {
	Alg() KeyAlg
	// ImportPrivate parses PEM or raw private-key material into a handle.
	// Returns ErrInsufficientKeyStrength, ErrMissingKeyPassphrase, or
	// ErrKeyDecryptionFailed as appropriate.
	ImportPrivate(material KeyMaterial, passphrase string) (PrivateKeyHandle, error)
	Sign(key PrivateKeyHandle, data []byte) ([]byte, error)
}

// Verifier verifies signatures for a specific algorithm.
type Verifier interface {
	Alg() KeyAlg
	ImportPublic(material KeyMaterial) (PublicKeyHandle, error)
	Verify(key PublicKeyHandle, data, signature []byte) (bool, error)
}

// KeyGenerator generates fresh keypairs for a specific algorithm. The
// private half is encrypted with passphrase before being returned in
// Pem.PrivatePem.
type KeyGenerator interface {
	Alg() KeyAlg
	Generate(passphrase string) (pem PemKeyMaterial, raw RawKeyMaterial, err error)
}

// SignatureBackend bundles all three capabilities for a single alg.
type SignatureBackend interface {
	Signer
	Verifier
	KeyGenerator
}

// -----------------------------------------------------------------------
// AlgorithmRegistry
// -----------------------------------------------------------------------

// AlgorithmRegistry maps alg → backend. A second registration for the same
// alg fails with ErrAlgorithmAlreadyRegistered — backends are expected to
// be registered exactly once at startup.
type AlgorithmRegistry struct {
	backends map[KeyAlg]SignatureBackend
	order    []KeyAlg
	mu       sync.RWMutex
}

// NewAlgorithmRegistry constructs an empty registry.
func NewAlgorithmRegistry() *AlgorithmRegistry {
	return &AlgorithmRegistry{backends: make(map[KeyAlg]SignatureBackend)}
}

// Register adds a backend. Returns ErrAlgorithmAlreadyRegistered if the
// alg is already bound.
func (r *AlgorithmRegistry) Register(b SignatureBackend) error {
	alg := b.Alg()
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.backends[alg]; exists {
		return newError(CodeAlgorithmAlreadyRegistered,
			fmt.Sprintf("a backend is already registered for alg: %s", alg),
			map[string]any{"alg": string(alg)})
	}
	r.backends[alg] = b
	r.order = append(r.order, alg)
	return nil
}

// Get returns the backend for alg, or ErrUnsupportedAlgorithm if absent.
func (r *AlgorithmRegistry) Get(alg KeyAlg) (SignatureBackend, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	b, ok := r.backends[alg]
	if !ok {
		return nil, newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("no backend registered for alg: %s", alg),
			map[string]any{"alg": string(alg)})
	}
	return b, nil
}

// Has reports whether alg has a registered backend.
func (r *AlgorithmRegistry) Has(alg KeyAlg) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.backends[alg]
	return ok
}

// Algs returns registered algs in registration order.
func (r *AlgorithmRegistry) Algs() []KeyAlg {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]KeyAlg, len(r.order))
	copy(out, r.order)
	return out
}

// -----------------------------------------------------------------------
// KeyAlgBindings — alg-confusion mitigation
// -----------------------------------------------------------------------

// KeyAlgBindings holds kid → alg pre-registrations. The verify path
// consults this BEFORE calling any backend, so a token whose header alg
// disagrees with the kid's registered alg fails with ErrAlgorithmMismatch
// rather than silently trying the wrong backend.
type KeyAlgBindings struct {
	bindings map[string]KeyAlg
	mu       sync.RWMutex
}

// NewKeyAlgBindings constructs an empty bindings table.
func NewKeyAlgBindings() *KeyAlgBindings {
	return &KeyAlgBindings{bindings: make(map[string]KeyAlg)}
}

// Bind records that kid is associated with alg. Binding the same kid to a
// different alg returns ErrAlgorithmMismatch.
func (b *KeyAlgBindings) Bind(kid string, alg KeyAlg) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if existing, ok := b.bindings[kid]; ok && existing != alg {
		return newError(CodeAlgorithmMismatch,
			fmt.Sprintf("alg mismatch for kid: expected %s, got %s", existing, alg),
			map[string]any{"expected": string(existing), "actual": string(alg)})
	}
	b.bindings[kid] = alg
	return nil
}

// Expect asserts that the incoming (kid, alg) matches a pre-registered pair.
// Returns ErrUnknownKid if the kid was never bound, ErrAlgorithmMismatch
// if the algs disagree.
func (b *KeyAlgBindings) Expect(kid string, alg KeyAlg) (KeyAlg, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	bound, ok := b.bindings[kid]
	if !ok {
		return "", newError(CodeUnknownKid,
			fmt.Sprintf("unknown kid: %s", kid),
			map[string]any{"kid": kid})
	}
	if bound != alg {
		return "", newError(CodeAlgorithmMismatch,
			fmt.Sprintf("alg mismatch for kid: expected %s, got %s", bound, alg),
			map[string]any{"expected": string(bound), "actual": string(alg)})
	}
	return bound, nil
}

// Get returns the alg bound to kid, or empty string if unbound.
func (b *KeyAlgBindings) Get(kid string) (KeyAlg, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	alg, ok := b.bindings[kid]
	return alg, ok
}
