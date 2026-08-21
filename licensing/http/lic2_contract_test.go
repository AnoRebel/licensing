package http

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed25519bk "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// openAPITokenPattern reads the activate/refresh token pattern straight out
// of the published spec, so this test constrains the real contract rather
// than a copy of it.
func openAPITokenPattern(t *testing.T) *regexp.Regexp {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	specPath := filepath.Join(wd, "..", "..", "openapi", "licensing-admin.yaml")
	data, err := os.ReadFile(specPath)
	if err != nil {
		t.Skipf("openapi spec not found at %s (%v)", specPath, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "pattern:") {
			continue
		}
		if !strings.Contains(trimmed, "LIC1") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimPrefix(trimmed, "pattern:"))
		raw = strings.Trim(raw, "'\"")
		re, err := regexp.Compile(raw)
		if err != nil {
			t.Fatalf("token pattern in the spec does not compile: %v", err)
		}
		return re
	}
	t.Fatal("no token pattern found in the openapi spec")
	return nil
}

// The activate/refresh response schema pins the token shape with a regex.
// It previously matched LIC1 only, so every response from a
// LIC2-configured deployment would have violated the published contract.
//
// This asserts the pattern against real tokens from both codecs rather
// than against a hand-written string, so a change to either envelope that
// breaks the contract fails here.
func TestOpenAPITokenPattern_AcceptsBothFormats(t *testing.T) {
	pattern := openAPITokenPattern(t)

	lic1, lic2 := realTokens(t)

	if !pattern.MatchString(lic1) {
		t.Errorf("contract pattern rejected a real LIC1 token: %s", lic1)
	}
	if !pattern.MatchString(lic2) {
		t.Errorf("contract pattern rejected a real LIC2 token: %s", lic2)
	}
}

// The pattern must stay a real constraint: a JWT-shaped or otherwise
// unregistered token must not satisfy it.
func TestOpenAPITokenPattern_RejectsForeignFormats(t *testing.T) {
	pattern := openAPITokenPattern(t)

	for _, bad := range []string{
		"eyJhbGciOiJub25lIn0.eyJhIjoxfQ.sig", // JWT
		"v4.local.abcdef.footer",             // PASETO symmetric mode, deliberately unsupported
		"LIC1.only.three",                    // wrong segment count
		"v9.public.abc.def",                  // unregistered version
		"",
	} {
		if pattern.MatchString(bad) {
			t.Errorf("contract pattern accepted %q, which is not a supported token", bad)
		}
	}
}

// realTokens mints one token per registered codec using the shared fixture
// key, so the assertions above are about actual output rather than a
// hand-copied literal.
func realTokens(t *testing.T) (string, string) {
	t.Helper()
	be := ed25519bk.New()
	pem, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "keys", "ed25519", "private.pem"))
	if err != nil {
		t.Skipf("fixture key unavailable: %v", err)
	}
	priv, err := be.ImportPrivate(lic.KeyMaterial{Pem: lic.PemKeyMaterial{PrivatePem: string(pem)}}, "")
	if err != nil {
		t.Fatalf("import fixture key: %v", err)
	}

	payload := map[string]any{"license_id": "lic-1", "scope": "example.app"}

	lic1, err := lic.LIC1Codec.Encode(lic.CodecEncodeInput{
		Alg: lic.AlgEd25519, Kid: "contract-kid", Payload: payload,
		PrivateKey: priv, Backend: be,
	})
	if err != nil {
		t.Fatalf("encode LIC1: %v", err)
	}
	lic2, err := lic.LIC2Codec.Encode(lic.CodecEncodeInput{
		Alg: lic.AlgEd25519, Kid: "contract-kid", Payload: payload,
		PrivateKey: priv, Backend: be,
	})
	if err != nil {
		t.Fatalf("encode LIC2: %v", err)
	}
	return lic1, lic2
}
