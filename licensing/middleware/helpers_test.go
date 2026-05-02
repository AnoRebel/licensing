package middleware_test

import (
	"reflect"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// forgeFreshToken mints a real Ed25519-signed LIC1 token suitable for
// the matrix test. Mirrors the helper in licensing/easy/guard_test.go
// but kept inside this package so the tests don't bring in the
// easy_test internal helpers.
func forgeFreshToken(t *testing.T, fingerprint string, nowSec int64) forgedToken {
	t.Helper()
	backend := ed.New()
	pemMat, _, err := backend.Generate("")
	if err != nil {
		t.Fatalf("ed25519 generate: %v", err)
	}
	priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: pemMat}, "")
	if err != nil {
		t.Fatalf("import priv: %v", err)
	}

	const kid = "matrix-test-kid"

	payload := lic.LIC1Payload{
		"jti":               "jti-matrix",
		"iat":               nowSec - 10,
		"nbf":               nowSec - 10,
		"exp":               nowSec + 3600,
		"scope":             "default",
		"license_id":        "lic-1",
		"usage_id":          "use-1",
		"usage_fingerprint": fingerprint,
		"status":            "active",
		"max_usages":        int64(1),
	}

	tok, err := lic.Encode(lic.EncodeOptions{
		Header: lic.LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: lic.AlgEd25519,
			Kid: kid,
		},
		Payload:    payload,
		PrivateKey: priv,
		Backend:    backend,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(backend); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind(kid, lic.AlgEd25519); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		kid: {
			Kid: kid,
			Alg: lic.AlgEd25519,
			Pem: lic.PemKeyMaterial{PublicPem: pemMat.PublicPem},
		},
	}
	return forgedToken{
		token:    tok,
		registry: reg,
		bindings: bindings,
		keys:     keys,
	}
}

// bodiesEqual is a structural-equality helper for matrix-response body
// maps. Uses reflect.DeepEqual since we're comparing decoded JSON,
// which gives us float64 for numbers and map[string]any for objects —
// reflect.DeepEqual handles those cleanly.
func bodiesEqual(a, b map[string]any) bool {
	return reflect.DeepEqual(a, b)
}
