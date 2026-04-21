package rsa_test

import (
	"bytes"
	"crypto/rand"
	stdrsa "crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	rpss "github.com/AnoRebel/licensing/licensing/crypto/rsa"
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
// Generate → Sign → Verify round-trip
//
// Generate is the slowest op in this suite (3072-bit key gen) but we only
// pay it once per test that needs a fresh key. The fixture-backed tests
// below avoid it entirely.
// -----------------------------------------------------------------------

func TestBackend_RoundTrip_PEM(t *testing.T) {
	be := rpss.New()
	pemMat, rawMat, err := be.Generate("")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.Contains(pemMat.PrivatePem, "PRIVATE KEY") {
		t.Fatalf("expected PKCS#8 PEM, got %q", pemMat.PrivatePem)
	}
	if !strings.Contains(pemMat.PublicPem, "PUBLIC KEY") {
		t.Fatalf("expected SPKI PEM, got %q", pemMat.PublicPem)
	}
	if len(rawMat.PrivateRaw) == 0 || len(rawMat.PublicRaw) == 0 {
		t.Fatal("generate returned empty DER")
	}

	priv, err := be.ImportPrivate(lic.KeyMaterial{Pem: pemMat}, "")
	if err != nil {
		t.Fatalf("importPrivate(pem): %v", err)
	}
	pub, err := be.ImportPublic(lic.KeyMaterial{Pem: pemMat})
	if err != nil {
		t.Fatalf("importPublic(pem): %v", err)
	}

	data := []byte("hello, licensing — rsa-pss")
	sig, err := be.Sign(priv, data)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// PSS sig length == modulus bytes. 3072 bits → 384 bytes.
	if len(sig) != 384 {
		t.Fatalf("sig length: want 384, got %d", len(sig))
	}

	ok, err := be.Verify(pub, data, sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("verify reported false on a genuine signature")
	}
}

func TestBackend_RoundTrip_DER(t *testing.T) {
	be := rpss.New()
	_, rawMat, err := be.Generate("")
	if err != nil {
		t.Fatal(err)
	}
	priv, err := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	if err != nil {
		t.Fatalf("importPrivate(der): %v", err)
	}
	pub, err := be.ImportPublic(lic.KeyMaterial{Raw: rawMat})
	if err != nil {
		t.Fatalf("importPublic(der): %v", err)
	}
	sig, err := be.Sign(priv, []byte("der path"))
	if err != nil {
		t.Fatal(err)
	}
	ok, err := be.Verify(pub, []byte("der path"), sig)
	if err != nil || !ok {
		t.Fatalf("verify: ok=%v err=%v", ok, err)
	}
}

// -----------------------------------------------------------------------
// PSS is randomized — two signatures over the same data must differ but
// both must still verify. This is the opposite of the Ed25519 determinism
// check, and confirms we're really using PSS (not deterministic PKCS#1 v1.5).
// -----------------------------------------------------------------------

func TestBackend_NonDeterministicSignatures(t *testing.T) {
	be := rpss.New()
	_, rawMat, _ := be.Generate("")
	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	pub, _ := be.ImportPublic(lic.KeyMaterial{Raw: rawMat})
	data := []byte("rand salt changes the sig")
	s1, _ := be.Sign(priv, data)
	s2, _ := be.Sign(priv, data)
	if bytes.Equal(s1, s2) {
		t.Fatal("two PSS sigs over the same data were identical — salt not randomized")
	}
	for _, s := range [][]byte{s1, s2} {
		ok, err := be.Verify(pub, data, s)
		if err != nil || !ok {
			t.Fatalf("pss sig did not verify: ok=%v err=%v", ok, err)
		}
	}
}

// -----------------------------------------------------------------------
// Tampering
// -----------------------------------------------------------------------

func TestBackend_TamperedSignatureRejected(t *testing.T) {
	be := rpss.New()
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
		t.Fatal("tampered signature accepted")
	}

	// Wrong-length sig: must return (false, nil), not an error.
	short := sig[:30]
	ok, err = be.Verify(pub, data, short)
	if err != nil || ok {
		t.Fatalf("expected (false, nil) for short sig, got (%v, %v)", ok, err)
	}
}

// -----------------------------------------------------------------------
// Raw-bytes accessors
// -----------------------------------------------------------------------

func TestRawAccessors(t *testing.T) {
	be := rpss.New()
	_, rawMat, _ := be.Generate("")
	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: rawMat}, "")
	gotPriv, err := rpss.PrivateDER(priv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPriv, rawMat.PrivateRaw) {
		t.Fatal("PrivateDER drift")
	}
	// Mutation of returned slice must not leak.
	gotPriv[0] ^= 0xFF
	gotPriv2, _ := rpss.PrivateDER(priv)
	if gotPriv[0] == gotPriv2[0] {
		t.Fatal("PrivateDER returned a shared slice — mutation leaked")
	}

	pub, _ := be.ImportPublic(lic.KeyMaterial{Raw: rawMat})
	gotPub, err := rpss.PublicDER(pub)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPub, rawMat.PublicRaw) {
		t.Fatal("PublicDER drift")
	}
}

// -----------------------------------------------------------------------
// Fixture-backed PEM import
// -----------------------------------------------------------------------

func TestBackend_ImportsFixturePEM(t *testing.T) {
	root := repoRoot(t)
	privBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "rsa", "private.pem"))
	if err != nil {
		t.Fatal(err)
	}
	pubBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "rsa", "public.pem"))
	if err != nil {
		t.Fatal(err)
	}

	be := rpss.New()
	priv, err := be.ImportPrivate(lic.KeyMaterial{Pem: lic.PemKeyMaterial{
		PrivatePem: string(privBytes),
	}}, "")
	if err != nil {
		t.Fatalf("import fixture private: %v", err)
	}
	pub, err := be.ImportPublic(lic.KeyMaterial{Pem: lic.PemKeyMaterial{
		PublicPem: string(pubBytes),
	}})
	if err != nil {
		t.Fatalf("import fixture public: %v", err)
	}

	h := sha256.Sum256([]byte("fixture-message-rsa"))
	sig, err := be.Sign(priv, h[:])
	if err != nil {
		t.Fatal(err)
	}
	ok, err := be.Verify(pub, h[:], sig)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("fixture keypair verify failed — public/private drift in fixtures/")
	}
}

// -----------------------------------------------------------------------
// Cross-language interop — TS-signed token verifies in Go
// -----------------------------------------------------------------------

func TestVerifyFixtureToken_002_RSAPSS(t *testing.T) {
	root := repoRoot(t)
	name := "002-rs256-pss-active"

	tokBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "expected_token.txt"))
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimRight(string(tokBytes), "\n")

	pubBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "rsa", "public.pem"))
	if err != nil {
		t.Fatal(err)
	}

	be := rpss.New()
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(be); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("fixture-rsa-1", lic.AlgRSAPSS); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		"fixture-rsa-1": {
			Kid: "fixture-rsa-1",
			Alg: lic.AlgRSAPSS,
			Pem: lic.PemKeyMaterial{PublicPem: string(pubBytes)},
		},
	}

	parts, err := lic.Verify(token, lic.VerifyOptions{
		Registry: reg,
		Bindings: bindings,
		Keys:     keys,
	})
	if err != nil {
		t.Fatalf("cross-language verify of TS-signed RSA-PSS token FAILED: %v", err)
	}
	if parts.Header.Kid != "fixture-rsa-1" {
		t.Fatalf("header drift: %+v", parts.Header)
	}
	if parts.Payload["jti"] != "jti-active-0" {
		t.Fatalf("payload.jti drift: %v", parts.Payload["jti"])
	}
}

// -----------------------------------------------------------------------
// Minimum key strength enforcement
//
// Generate a 1024-bit key in-test and try to import it. Must be rejected
// at import time, before anyone hands it a signing input.
// -----------------------------------------------------------------------

func TestImportPrivate_RejectsUnderstrengthKey(t *testing.T) {
	tiny, err := stdrsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(tiny)
	if err != nil {
		t.Fatal(err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})

	be := rpss.New()
	_, err = be.ImportPrivate(lic.KeyMaterial{Pem: lic.PemKeyMaterial{
		PrivatePem: string(pemBlock),
	}}, "")
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength for 1024-bit key, got %v", err)
	}
}

func TestImportPublic_RejectsUnderstrengthKey(t *testing.T) {
	tiny, err := stdrsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&tiny.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki})

	be := rpss.New()
	_, err = be.ImportPublic(lic.KeyMaterial{Pem: lic.PemKeyMaterial{
		PublicPem: string(pemBlock),
	}})
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength for 1024-bit key, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------

func TestImportPrivate_GarbagePEM(t *testing.T) {
	_, err := rpss.New().ImportPrivate(lic.KeyMaterial{
		Pem: lic.PemKeyMaterial{PrivatePem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"},
	}, "")
	if !errors.Is(err, lic.ErrKeyDecryptionFailed) {
		t.Fatalf("expected KeyDecryptionFailed, got %v", err)
	}
}

func TestImportPrivate_WrongPEMType(t *testing.T) {
	_, err := rpss.New().ImportPrivate(lic.KeyMaterial{
		Pem: lic.PemKeyMaterial{PrivatePem: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"},
	}, "")
	// Wrong PEM header type — PKCS#1, not PKCS#8. We reject before even
	// attempting DER parse.
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestImportPrivate_MissingMaterial(t *testing.T) {
	_, err := rpss.New().ImportPrivate(lic.KeyMaterial{}, "")
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestImportPublic_MissingMaterial(t *testing.T) {
	_, err := rpss.New().ImportPublic(lic.KeyMaterial{})
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

// Importing an Ed25519 DER under the RSA backend should fail at the type
// assertion, not silently mis-parse. This is a form of alg-confusion guard
// at the backend boundary.
func TestImportPrivate_RejectsNonRSAKey(t *testing.T) {
	// Read the ed25519 fixture private key, extract its DER, feed it to rpss.
	root := repoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "ed25519", "private.pem"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = rpss.New().ImportPrivate(lic.KeyMaterial{Pem: lic.PemKeyMaterial{
		PrivatePem: string(b),
	}}, "")
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength for non-RSA key, got %v", err)
	}
}
