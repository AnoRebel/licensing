package licensing

import (
	"bytes"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

func TestWrapUnwrap_RoundTrip(t *testing.T) {
	// Arbitrary plaintext stands in for a PKCS#8 DER blob.
	plaintext := make([]byte, 1024)
	if _, err := rand.Read(plaintext); err != nil {
		t.Fatal(err)
	}
	passphrase := "s3cr3t-passphrase"

	pemStr, err := WrapEncryptedPKCS8(plaintext, passphrase)
	if err != nil {
		t.Fatalf("wrap: %v", err)
	}
	if !strings.Contains(pemStr, "BEGIN ENCRYPTED PRIVATE KEY") {
		t.Fatalf("expected ENCRYPTED PRIVATE KEY armor, got: %q", pemStr)
	}

	recovered, err := UnwrapEncryptedPKCS8(pemStr, passphrase)
	if err != nil {
		t.Fatalf("unwrap: %v", err)
	}
	if !bytes.Equal(recovered, plaintext) {
		t.Fatal("round-trip drift")
	}
}

func TestUnwrap_WrongPassphrase(t *testing.T) {
	plaintext := []byte("cleartext secret")
	pemStr, err := WrapEncryptedPKCS8(plaintext, "correct")
	if err != nil {
		t.Fatal(err)
	}
	_, err = UnwrapEncryptedPKCS8(pemStr, "wrong")
	if !errors.Is(err, ErrKeyDecryptionFailed) {
		t.Fatalf("expected KeyDecryptionFailed, got %v", err)
	}
}

func TestUnwrap_TamperedCiphertext(t *testing.T) {
	plaintext := []byte("cleartext secret")
	pemStr, err := WrapEncryptedPKCS8(plaintext, "pw")
	if err != nil {
		t.Fatal(err)
	}
	// Flip a byte in the middle of the PEM base64 body.
	lines := strings.Split(pemStr, "\n")
	if len(lines) < 3 {
		t.Fatal("unexpected PEM shape")
	}
	// lines[1] is the first base64 line.
	body := []byte(lines[1])
	body[10] ^= 1
	lines[1] = string(body)
	tampered := strings.Join(lines, "\n")

	_, err = UnwrapEncryptedPKCS8(tampered, "pw")
	// Either the bit-flip lands inside asn1 structure (TokenMalformed) or
	// inside the ciphertext (KeyDecryptionFailed via GCM auth failure).
	// Both are acceptable rejections.
	if err == nil {
		t.Fatal("tampered envelope accepted")
	}
	if !errors.Is(err, ErrKeyDecryptionFailed) && !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected KeyDecryptionFailed or TokenMalformed, got %v", err)
	}
}

func TestWrap_RejectsEmptyPassphrase(t *testing.T) {
	_, err := WrapEncryptedPKCS8([]byte("x"), "")
	if !errors.Is(err, ErrMissingKeyPassphrase) {
		t.Fatalf("expected MissingKeyPassphrase, got %v", err)
	}
}

func TestUnwrap_RejectsEmptyPassphrase(t *testing.T) {
	pemStr, err := WrapEncryptedPKCS8([]byte("x"), "good")
	if err != nil {
		t.Fatal(err)
	}
	_, err = UnwrapEncryptedPKCS8(pemStr, "")
	if !errors.Is(err, ErrMissingKeyPassphrase) {
		t.Fatalf("expected MissingKeyPassphrase, got %v", err)
	}
}

func TestUnwrap_RejectsNonPEM(t *testing.T) {
	_, err := UnwrapEncryptedPKCS8("not a pem", "pw")
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}
