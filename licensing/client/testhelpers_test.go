package client

import (
	"crypto/sha256"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

// fakeBackend is a deterministic SHA-256-based signature backend, sufficient
// for testing the client's verify/validate plumbing without pulling in real
// Ed25519/RSA machinery.
type fakeBackend struct{}

func (fakeBackend) Alg() lic.KeyAlg { return lic.AlgEd25519 }
func (fakeBackend) ImportPrivate(_ lic.KeyMaterial, _ string) (lic.PrivateKeyHandle, error) {
	return struct{}{}, nil
}
func (fakeBackend) ImportPublic(_ lic.KeyMaterial) (lic.PublicKeyHandle, error) {
	return struct{}{}, nil
}
func (fakeBackend) Sign(_ lic.PrivateKeyHandle, data []byte) ([]byte, error) {
	h := sha256.Sum256(append([]byte("fake-secret:"), data...))
	return h[:], nil
}
func (fakeBackend) Verify(_ lic.PublicKeyHandle, data, sig []byte) (bool, error) {
	h := sha256.Sum256(append([]byte("fake-secret:"), data...))
	if len(sig) != len(h) {
		return false, nil
	}
	for i := range h {
		if h[i] != sig[i] {
			return false, nil
		}
	}
	return true, nil
}
func (fakeBackend) Generate(_ string) (lic.PemKeyMaterial, lic.RawKeyMaterial, error) {
	return lic.PemKeyMaterial{}, lic.RawKeyMaterial{}, nil
}

// verifyDeps returns a freshly-constructed Registry + Bindings + Keys map
// configured for the fakeBackend and kid "test-kid".
func verifyDeps(t *testing.T) (*lic.AlgorithmRegistry, *lic.KeyAlgBindings, map[string]lic.KeyRecord) {
	t.Helper()
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(fakeBackend{}); err != nil {
		t.Fatalf("register: %v", err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("test-kid", lic.AlgEd25519); err != nil {
		t.Fatalf("bind: %v", err)
	}
	keys := map[string]lic.KeyRecord{
		"test-kid": {Kid: "test-kid", Alg: lic.AlgEd25519},
	}
	return reg, bindings, keys
}

// issueTestToken builds a signed LIC1 token with the given payload using
// fakeBackend. Caller is responsible for supplying all required claims
// (jti, iat, nbf, exp, scope, license_id, usage_id, usage_fingerprint,
// status, max_usages).
func issueTestToken(t *testing.T, payload lic.LIC1Payload) string {
	t.Helper()
	tok, err := lic.Encode(lic.EncodeOptions{
		Header: lic.LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: lic.AlgEd25519,
			Kid: "test-kid",
		},
		Payload:    payload,
		PrivateKey: struct{}{},
		Backend:    fakeBackend{},
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return tok
}

// basePayload returns a minimally-valid LIC1Payload with sensible defaults.
// Callers overwrite individual keys for failure-mode tests.
func basePayload(now int64) lic.LIC1Payload {
	return lic.LIC1Payload{
		"jti":               "jti-1",
		"iat":               now - 10,
		"nbf":               now - 10,
		"exp":               now + 3600,
		"scope":             "default",
		"license_id":        "lic-1",
		"usage_id":          "use-1",
		"usage_fingerprint": "fp-1",
		"status":            "active",
		"max_usages":        int64(1),
	}
}
