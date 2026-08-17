// Package trials provides operator-managed pepper handling for the
// trial-issuance fingerprint hash. Mirrors typescript/src/trials/pepper.ts —
// the hash output is byte-identical for a given (pepper, fingerprint) pair
// across both ports, so deduplication works regardless of which port issues
// a trial. Cross-port byte-compat is enforced by the interop test suite.
//
// The pepper is read from the LICENSING_TRIAL_PEPPER environment variable
// by default. We deliberately do not persist it inside the licensing
// database — see the TS doc-comment for the threat model.
package trials

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
)

// MinPepperLength is the minimum pepper length we accept. 32 chars is the
// floor for the digest to be unrecoverable in a leaked table.
const MinPepperLength = 32

// HashFingerprint produces the HMAC-SHA256 hex digest of the fingerprint
// input keyed by the pepper, lowercase, 64 chars — the exact shape
// persisted in trial_issuances.fingerprint_hash.
//
// HMAC rather than the simpler SHA-256(pepper || input): that prefix-MAC
// construction is length-extension-susceptible, so its safety depends on the
// digest never being treated as an authenticator. HMAC makes the primitive
// itself safe, independent of the call site.
func HashFingerprint(pepper, fingerprintInput string) (string, error) {
	if len(pepper) < MinPepperLength {
		return "", fmt.Errorf("pepper must be at least %d characters (got %d)",
			MinPepperLength, len(pepper))
	}
	m := hmac.New(sha256.New, []byte(pepper))
	_, _ = m.Write([]byte(fingerprintInput))
	return hex.EncodeToString(m.Sum(nil)), nil
}

// PepperFromEnv reads the pepper from the LICENSING_TRIAL_PEPPER env var
// (or a caller-supplied lookup function) and validates length.
func PepperFromEnv() (string, error) {
	v := os.Getenv("LICENSING_TRIAL_PEPPER")
	if v == "" {
		return "", fmt.Errorf("LICENSING_TRIAL_PEPPER is required for trial issuance " +
			"(>= 32 chars; e.g. `openssl rand -hex 32`)")
	}
	if len(v) < MinPepperLength {
		return "", fmt.Errorf("LICENSING_TRIAL_PEPPER must be at least %d characters (got %d)",
			MinPepperLength, len(v))
	}
	return v, nil
}

// PepperStore is the high-level facade most consumers will use.
type PepperStore struct {
	pepper string
}

// NewPepperStore validates the pepper length and returns a store ready to hash.
func NewPepperStore(pepper string) (*PepperStore, error) {
	if len(pepper) < MinPepperLength {
		return nil, fmt.Errorf("pepper must be at least %d characters (got %d)",
			MinPepperLength, len(pepper))
	}
	return &PepperStore{pepper: pepper}, nil
}

// PepperStoreFromEnv builds a store from LICENSING_TRIAL_PEPPER.
func PepperStoreFromEnv() (*PepperStore, error) {
	p, err := PepperFromEnv()
	if err != nil {
		return nil, err
	}
	return NewPepperStore(p)
}

// Hash hashes a canonical fingerprint input through the store's pepper.
func (s *PepperStore) Hash(fingerprintInput string) (string, error) {
	return HashFingerprint(s.pepper, fingerprintInput)
}
