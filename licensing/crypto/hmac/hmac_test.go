package hmac_test

import (
	"bytes"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	hm "github.com/AnoRebel/licensing/licensing/crypto/hmac"
)

// repoRoot walks up until it finds fixtures/.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for range 10 {
		if _, err := os.Stat(filepath.Join(dir, "fixtures", "keys")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate repo root from %s", dir)
	return ""
}

// -----------------------------------------------------------------------
// Round-trip
// -----------------------------------------------------------------------

func TestBackend_RoundTrip(t *testing.T) {
	be := hm.New()
	_, rawMat, err := be.Generate("")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(rawMat.PrivateRaw) != hm.DefaultSecretLen {
		t.Fatalf("generated secret len %d, want %d", len(rawMat.PrivateRaw), hm.DefaultSecretLen)
	}
	// PrivateRaw and PublicRaw should be value-equal for the symmetric case
	// but not alias each other.
	if !bytes.Equal(rawMat.PrivateRaw, rawMat.PublicRaw) {
		t.Fatal("generate: private and public raw secrets differ for HMAC")
	}
	rawMat.PrivateRaw[0] ^= 0xFF
	if bytes.Equal(rawMat.PrivateRaw, rawMat.PublicRaw) {
		t.Fatal("generate: PrivateRaw and PublicRaw alias the same backing array")
	}
	rawMat.PrivateRaw[0] ^= 0xFF // restore for the sign path below

	priv, err := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	if err != nil {
		t.Fatal(err)
	}
	pub, err := be.ImportPublic(lic.KeyMaterial{Raw: rawMat})
	if err != nil {
		t.Fatal(err)
	}

	data := []byte("hello, licensing — hmac")
	sig, err := be.Sign(priv, data)
	if err != nil {
		t.Fatal(err)
	}
	if len(sig) != hm.SignatureLen {
		t.Fatalf("sig len %d, want %d", len(sig), hm.SignatureLen)
	}
	ok, err := be.Verify(pub, data, sig)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("verify reported false on a genuine HMAC")
	}

	// HMAC is deterministic — same secret + data → same MAC.
	sig2, _ := be.Sign(priv, data)
	if !bytes.Equal(sig, sig2) {
		t.Fatal("HMAC should be deterministic — two sigs over same data differed")
	}
}

// -----------------------------------------------------------------------
// Tampering
// -----------------------------------------------------------------------

func TestBackend_TamperedSignatureRejected(t *testing.T) {
	be := hm.New()
	_, rawMat, _ := be.Generate("")
	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	pub, _ := be.ImportPublic(lic.KeyMaterial{Raw: rawMat})
	data := []byte("message")
	sig, _ := be.Sign(priv, data)

	tampered := bytes.Clone(sig)
	tampered[0] ^= 1
	ok, err := be.Verify(pub, data, tampered)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("tampered HMAC accepted")
	}

	// Wrong-length sig: (false, nil), not an error.
	short := sig[:16]
	ok, err = be.Verify(pub, data, short)
	if err != nil || ok {
		t.Fatalf("expected (false, nil) for short sig, got (%v, %v)", ok, err)
	}

	// Wrong data, same sig.
	ok, err = be.Verify(pub, []byte("different message"), sig)
	if err != nil || ok {
		t.Fatalf("verify with wrong data: ok=%v err=%v", ok, err)
	}
}

// -----------------------------------------------------------------------
// Key strength enforcement
// -----------------------------------------------------------------------

func TestImportPrivate_RejectsShortSecret(t *testing.T) {
	short := make([]byte, 16) // 16 bytes, below the 32-byte floor
	_, err := hm.New().ImportPrivate(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PrivateRaw: short},
	}, "")
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength, got %v", err)
	}
}

func TestImportPublic_RejectsShortSecret(t *testing.T) {
	short := make([]byte, 31) // one byte under the floor
	_, err := hm.New().ImportPublic(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PublicRaw: short},
	})
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength, got %v", err)
	}
}

func TestImport_RejectsPEMInput(t *testing.T) {
	_, err := hm.New().ImportPrivate(lic.KeyMaterial{
		Pem: lic.PemKeyMaterial{PrivatePem: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----"},
	}, "")
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed for PEM-to-HMAC, got %v", err)
	}
	_, err = hm.New().ImportPublic(lic.KeyMaterial{
		Pem: lic.PemKeyMaterial{PublicPem: "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----"},
	})
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed for PEM-to-HMAC, got %v", err)
	}
}

func TestImport_MissingMaterial(t *testing.T) {
	_, err := hm.New().ImportPrivate(lic.KeyMaterial{}, "")
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Secret accessor + isolation
// -----------------------------------------------------------------------

func TestSecret_Isolation(t *testing.T) {
	be := hm.New()
	_, rawMat, _ := be.Generate("")
	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	got, err := hm.Secret(priv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, rawMat.PublicRaw) {
		t.Fatal("Secret drift")
	}
	// Mutating the returned secret must not mutate the handle.
	got[0] ^= 0xFF
	got2, _ := hm.Secret(priv)
	if got[0] == got2[0] {
		t.Fatal("Secret returned a shared slice — mutation leaked")
	}
}

// -----------------------------------------------------------------------
// Fixture-backed interop
// -----------------------------------------------------------------------

func readHmacFixtureSecret(t *testing.T) []byte {
	t.Helper()
	root := repoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "hmac", "secret.hex"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestBackend_ImportsFixtureSecret(t *testing.T) {
	be := hm.New()
	secret := readHmacFixtureSecret(t)
	priv, err := be.ImportPrivate(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PrivateRaw: secret},
	}, "")
	if err != nil {
		t.Fatalf("import fixture secret (priv): %v", err)
	}
	pub, err := be.ImportPublic(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PublicRaw: secret},
	})
	if err != nil {
		t.Fatalf("import fixture secret (pub): %v", err)
	}
	sig, err := be.Sign(priv, []byte("ping"))
	if err != nil {
		t.Fatal(err)
	}
	ok, err := be.Verify(pub, []byte("ping"), sig)
	if err != nil || !ok {
		t.Fatalf("fixture secret verify failed: ok=%v err=%v", ok, err)
	}
}

// Cross-language interop — TS-signed HMAC token verifies in Go.
func TestVerifyFixtureToken_003_HS256(t *testing.T) {
	root := repoRoot(t)
	name := "003-hs256-active"
	tokBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "expected_token.txt"))
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimRight(string(tokBytes), "\n")

	secret := readHmacFixtureSecret(t)

	be := hm.New()
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(be); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("fixture-hmac-1", lic.AlgHS256); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		"fixture-hmac-1": {
			Kid: "fixture-hmac-1",
			Alg: lic.AlgHS256,
			Raw: lic.RawKeyMaterial{PublicRaw: secret},
		},
	}

	parts, err := lic.Verify(token, lic.VerifyOptions{
		Registry: reg,
		Bindings: bindings,
		Keys:     keys,
	})
	if err != nil {
		t.Fatalf("cross-language verify of TS-signed HMAC token FAILED: %v", err)
	}
	if parts.Header.Kid != "fixture-hmac-1" {
		t.Fatalf("header drift: %+v", parts.Header)
	}
	if parts.Payload["jti"] != "jti-active-0" {
		t.Fatalf("payload.jti drift: %v", parts.Payload["jti"])
	}
}
