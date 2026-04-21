package ed25519_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// repoRoot walks up from the package directory until it finds fixtures/.
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
// -----------------------------------------------------------------------

func TestBackend_RoundTrip(t *testing.T) {
	be := ed.New()

	pem, raw, err := be.Generate("")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(raw.PrivateRaw) != ed.RawSeedLen {
		t.Fatalf("seed length: want %d, got %d", ed.RawSeedLen, len(raw.PrivateRaw))
	}
	if len(raw.PublicRaw) != ed.RawPubLen {
		t.Fatalf("pub length: want %d, got %d", ed.RawPubLen, len(raw.PublicRaw))
	}
	if !strings.Contains(pem.PrivatePem, "PRIVATE KEY") {
		t.Fatalf("expected PKCS#8 PEM, got %q", pem.PrivatePem)
	}
	if !strings.Contains(pem.PublicPem, "PUBLIC KEY") {
		t.Fatalf("expected SPKI PEM, got %q", pem.PublicPem)
	}

	// Sign + verify via raw path.
	privRaw, err := be.ImportPrivate(lic.KeyMaterial{Raw: raw}, "")
	if err != nil {
		t.Fatalf("importPrivate(raw): %v", err)
	}
	data := []byte("hello, licensing")
	sig, err := be.Sign(privRaw, data)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if len(sig) != ed.SignatureLen {
		t.Fatalf("sig length: want %d, got %d", ed.SignatureLen, len(sig))
	}

	pubRaw, err := be.ImportPublic(lic.KeyMaterial{Raw: raw})
	if err != nil {
		t.Fatalf("importPublic(raw): %v", err)
	}
	ok, err := be.Verify(pubRaw, data, sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("verify reported false on a genuine signature")
	}

	// Same thing via PEM path.
	privPem, err := be.ImportPrivate(lic.KeyMaterial{Pem: pem}, "")
	if err != nil {
		t.Fatalf("importPrivate(pem): %v", err)
	}
	sig2, err := be.Sign(privPem, data)
	if err != nil {
		t.Fatalf("sign(pem): %v", err)
	}
	// Ed25519 is deterministic — same message + same key → same signature.
	if !bytes.Equal(sig, sig2) {
		t.Fatalf("ed25519 signatures should be deterministic\n raw: %x\n pem: %x", sig, sig2)
	}

	pubPem, err := be.ImportPublic(lic.KeyMaterial{Pem: pem})
	if err != nil {
		t.Fatalf("importPublic(pem): %v", err)
	}
	ok, err = be.Verify(pubPem, data, sig)
	if err != nil {
		t.Fatalf("verify(pem): %v", err)
	}
	if !ok {
		t.Fatal("verify(pem) reported false on a genuine signature")
	}
}

// -----------------------------------------------------------------------
// Tampered signature rejected
// -----------------------------------------------------------------------

func TestBackend_TamperedSignatureRejected(t *testing.T) {
	be := ed.New()
	_, raw, err := be.Generate("")
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: raw}, "")
	pub, _ := be.ImportPublic(lic.KeyMaterial{Raw: raw})
	data := []byte("message")
	sig, _ := be.Sign(priv, data)

	// Flip the first bit.
	tampered := bytes.Clone(sig)
	tampered[0] ^= 1
	ok, err := be.Verify(pub, data, tampered)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("tampered signature accepted")
	}

	// Wrong-length signature: should return (false, nil) per contract,
	// not an error.
	short := sig[:30]
	ok, err = be.Verify(pub, data, short)
	if err != nil || ok {
		t.Fatalf("expected (false, nil) for short sig, got (%v, %v)", ok, err)
	}
}

// -----------------------------------------------------------------------
// Raw-bytes accessors
// -----------------------------------------------------------------------

func TestRawAccessors_RoundTrip(t *testing.T) {
	be := ed.New()
	_, raw, err := be.Generate("")
	if err != nil {
		t.Fatal(err)
	}

	priv, _ := be.ImportPrivate(lic.KeyMaterial{Raw: raw}, "")
	gotSeed, err := ed.PrivateSeed(priv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotSeed, raw.PrivateRaw) {
		t.Fatalf("seed round-trip drift\nwant %x\n got %x", raw.PrivateRaw, gotSeed)
	}

	pub, _ := be.ImportPublic(lic.KeyMaterial{Raw: raw})
	gotPub, err := ed.PublicRaw(pub)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPub, raw.PublicRaw) {
		t.Fatalf("pub round-trip drift")
	}

	// PEM-imported handles expose the same raw bytes as the raw-imported handles.
	pemMat, _, _ := be.Generate("")
	privPem, _ := be.ImportPrivate(lic.KeyMaterial{Pem: pemMat}, "")
	seed2, err := ed.PrivateSeed(privPem)
	if err != nil {
		t.Fatal(err)
	}
	if len(seed2) != ed.RawSeedLen {
		t.Fatalf("PEM seed length %d", len(seed2))
	}
	pubPem, _ := be.ImportPublic(lic.KeyMaterial{Pem: pemMat})
	pubBytes, err := ed.PublicRaw(pubPem)
	if err != nil {
		t.Fatal(err)
	}
	if len(pubBytes) != ed.RawPubLen {
		t.Fatalf("PEM pub length %d", len(pubBytes))
	}

	// Mutating the returned slice must not mutate the handle.
	seed2[0] ^= 0xFF
	seed3, _ := ed.PrivateSeed(privPem)
	if seed3[0] == seed2[0] {
		t.Fatalf("PrivateSeed returned a shared slice — mutation leaked")
	}
}

// -----------------------------------------------------------------------
// Fixture-backed PEM import: the repo's committed fixture keys must load.
// -----------------------------------------------------------------------

func TestBackend_ImportsFixturePEM(t *testing.T) {
	root := repoRoot(t)
	privBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "ed25519", "private.pem"))
	if err != nil {
		t.Fatal(err)
	}
	pubBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "ed25519", "public.pem"))
	if err != nil {
		t.Fatal(err)
	}

	be := ed.New()
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

	// Hash a known message and sign it; the signature must verify.
	h := sha256.Sum256([]byte("fixture-message"))
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
// Cross-language interop: can we VERIFY a TS-signed fixture token?
// This is the real test — the signature, kid binding, and public-key
// bytes all agree across runtimes or this test fails.
// -----------------------------------------------------------------------

func TestVerifyFixtureToken_001_Ed25519(t *testing.T) {
	root := repoRoot(t)
	name := "001-ed25519-active"

	tokBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "expected_token.txt"))
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimRight(string(tokBytes), "\n")

	pubBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "keys", "ed25519", "public.pem"))
	if err != nil {
		t.Fatal(err)
	}

	// Build verify deps — register the real ed25519 backend, bind the
	// fixture kid, and drop a KeyRecord with the fixture public key.
	be := ed.New()
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(be); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("fixture-ed25519-1", lic.AlgEd25519); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		"fixture-ed25519-1": {
			Kid: "fixture-ed25519-1",
			Alg: lic.AlgEd25519,
			Pem: lic.PemKeyMaterial{PublicPem: string(pubBytes)},
		},
	}

	parts, err := lic.Verify(token, lic.VerifyOptions{
		Registry: reg,
		Bindings: bindings,
		Keys:     keys,
	})
	if err != nil {
		t.Fatalf("cross-language verify of TS-signed token FAILED: %v", err)
	}
	if parts.Header.Kid != "fixture-ed25519-1" {
		t.Fatalf("header drift: %+v", parts.Header)
	}
	// Spot-check a payload field.
	if parts.Payload["jti"] != "jti-active-0" {
		t.Fatalf("payload.jti drift: %v", parts.Payload["jti"])
	}
}

// -----------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------

func TestImportPrivate_WrongSeedLength(t *testing.T) {
	_, err := ed.New().ImportPrivate(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PrivateRaw: make([]byte, 16)},
	}, "")
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength, got %v", err)
	}
}

func TestImportPublic_WrongLength(t *testing.T) {
	_, err := ed.New().ImportPublic(lic.KeyMaterial{
		Raw: lic.RawKeyMaterial{PublicRaw: make([]byte, 8)},
	})
	if !errors.Is(err, lic.ErrInsufficientKeyStrength) {
		t.Fatalf("expected InsufficientKeyStrength, got %v", err)
	}
}

func TestImportPrivate_GarbagePEM(t *testing.T) {
	_, err := ed.New().ImportPrivate(lic.KeyMaterial{
		Pem: lic.PemKeyMaterial{PrivatePem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"},
	}, "")
	if !errors.Is(err, lic.ErrKeyDecryptionFailed) {
		t.Fatalf("expected KeyDecryptionFailed, got %v", err)
	}
}

func TestImportPrivate_MissingMaterial(t *testing.T) {
	_, err := ed.New().ImportPrivate(lic.KeyMaterial{}, "")
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}
