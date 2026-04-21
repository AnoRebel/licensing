package licensing

// Encrypted PKCS#8 wrapping with PBES2 / PBKDF2-HMAC-SHA-256 / AES-256-GCM.
//
// Go's crypto/x509 can PARSE encrypted PKCS#8 via ParsePKCS8PrivateKey on
// decrypted DER, but it does NOT emit AES-GCM encrypted PKCS#8 — it produces
// PBES2 + AES-CBC only. We need bit-for-bit interop with the TS port's
// encrypted-pkcs8.ts, which hand-builds an AES-GCM envelope. So we do the
// same here, using encoding/asn1 for DER codec.
//
// Structure (RFC 8018 §6.2, RFC 5084 §3):
//
//	EncryptedPrivateKeyInfo ::= SEQUENCE {
//	  encryptionAlgorithm  AlgorithmIdentifier,    -- PBES2
//	  encryptedData        OCTET STRING            -- AES-GCM ciphertext || tag
//	}
//
// Parameters fixed to match the TS emitter:
//   - Salt: 16 random bytes
//   - PBKDF2 iterations: 600,000 (OWASP 2024 guidance for PBKDF2-HMAC-SHA-256)
//   - KDF output length: 32 bytes
//   - GCM nonce: 12 random bytes
//   - GCM tag length: 16 bytes
//
// PEM armor: "ENCRYPTED PRIVATE KEY".

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/pem"
	"fmt"
)

// Profile parameters — must match @anorebel/licensing/encrypted-pkcs8.ts.
const (
	PBKDF2Iterations = 600_000
	PBKDF2SaltLen    = 16
	EncryptionKeyLen = 32
	GCMNonceLen      = 12
	GCMTagLen        = 16
)

// Known OIDs.
var (
	oidPBES2          = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 13}
	oidPBKDF2         = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 12}
	oidHMACWithSHA256 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 9}
	oidAES256GCM      = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 46}
)

// -----------------------------------------------------------------------
// ASN.1 structures
// -----------------------------------------------------------------------

// prfAlgID is the PBKDF2 PRF identifier (hmac-with-SHA256 with explicit NULL
// parameter). We encode Parameters as raw asn1.RawValue{Tag: asn1.TagNull}.
type prfAlgID struct {
	Algorithm  asn1.ObjectIdentifier
	Parameters asn1.RawValue
}

type pbkdf2Params struct {
	PRF            prfAlgID
	Salt           []byte
	IterationCount int
	KeyLength      int
}

type pbkdf2AlgID struct {
	Algorithm  asn1.ObjectIdentifier
	Parameters pbkdf2Params
}

type gcmParams struct {
	Nonce     []byte
	ICVLength int
}

type gcmAlgID struct {
	Algorithm  asn1.ObjectIdentifier
	Parameters gcmParams
}

type pbes2Params struct {
	Cipher gcmAlgID
	KDF    pbkdf2AlgID
}

type pbes2AlgID struct {
	Algorithm  asn1.ObjectIdentifier
	Parameters pbes2Params
}

type encryptedPrivateKeyInfo struct {
	EncryptedData       []byte
	EncryptionAlgorithm pbes2AlgID
}

var asn1Null = asn1.RawValue{Tag: asn1.TagNull}

// -----------------------------------------------------------------------
// Wrap / unwrap
// -----------------------------------------------------------------------

// WrapEncryptedPKCS8 encrypts plaintextDER (a PKCS#8 private-key DER) under
// `passphrase` and returns the resulting PEM (`-----BEGIN ENCRYPTED PRIVATE
// KEY-----`) string. Returns ErrMissingKeyPassphrase for an empty passphrase.
func WrapEncryptedPKCS8(plaintextDER []byte, passphrase string) (string, error) {
	if len(passphrase) == 0 {
		return "", newError(CodeMissingKeyPassphrase,
			"encrypted PKCS#8 wrap requires a non-empty passphrase", nil)
	}

	salt := make([]byte, PBKDF2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	nonce := make([]byte, GCMNonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	kek, err := pbkdf2.Key(sha256.New, passphrase, salt, PBKDF2Iterations, EncryptionKeyLen)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCMWithTagSize(block, GCMTagLen)
	if err != nil {
		return "", err
	}
	// cipher.GCM.Seal appends the tag; matches the `ct || tag` wire layout
	// the TS side produces via createCipheriv + getAuthTag.
	ciphertext := aead.Seal(nil, nonce, plaintextDER, nil)

	envelope := encryptedPrivateKeyInfo{
		EncryptionAlgorithm: pbes2AlgID{
			Algorithm: oidPBES2,
			Parameters: pbes2Params{
				KDF: pbkdf2AlgID{
					Algorithm: oidPBKDF2,
					Parameters: pbkdf2Params{
						Salt:           salt,
						IterationCount: PBKDF2Iterations,
						KeyLength:      EncryptionKeyLen,
						PRF: prfAlgID{
							Algorithm:  oidHMACWithSHA256,
							Parameters: asn1Null,
						},
					},
				},
				Cipher: gcmAlgID{
					Algorithm: oidAES256GCM,
					Parameters: gcmParams{
						Nonce:     nonce,
						ICVLength: GCMTagLen,
					},
				},
			},
		},
		EncryptedData: ciphertext,
	}

	der, err := asn1.Marshal(envelope)
	if err != nil {
		return "", fmt.Errorf("encrypted PKCS#8: marshal failed: %w", err)
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "ENCRYPTED PRIVATE KEY", Bytes: der})
	return string(out), nil
}

// UnwrapEncryptedPKCS8 decrypts an envelope produced by WrapEncryptedPKCS8
// (or compatible — i.e., PBES2 + PBKDF2-HMAC-SHA-256 + AES-256-GCM). Returns
// the plaintext PKCS#8 DER.
//
// Rejects parameter sets that deviate from the expected profile so attackers
// can't downgrade us to a weaker cipher via a crafted envelope.
func UnwrapEncryptedPKCS8(pemText, passphrase string) ([]byte, error) {
	if len(passphrase) == 0 {
		return nil, newError(CodeMissingKeyPassphrase,
			"encrypted PKCS#8 unwrap requires a non-empty passphrase", nil)
	}

	blk, _ := pem.Decode([]byte(pemText))
	if blk == nil {
		return nil, newError(CodeTokenMalformed,
			"encrypted PKCS#8: missing PEM armor", nil)
	}
	if blk.Type != "ENCRYPTED PRIVATE KEY" {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("encrypted PKCS#8: expected PEM type \"ENCRYPTED PRIVATE KEY\", got %q", blk.Type),
			nil)
	}

	var env encryptedPrivateKeyInfo
	rest, err := asn1.Unmarshal(blk.Bytes, &env)
	if err != nil {
		return nil, newError(CodeTokenMalformed,
			"encrypted PKCS#8: ASN.1 parse failed: "+err.Error(), nil)
	}
	if len(rest) != 0 {
		return nil, newError(CodeTokenMalformed,
			"encrypted PKCS#8: trailing bytes after envelope", nil)
	}

	// Enforce the fixed profile. All profile-mismatch failures collapse to
	// the same opaque KeyDecryptionFailed string so an attacker with only
	// an error-log channel can't distinguish "wrong passphrase" from
	// "crafted downgrade envelope" — these are all "this envelope cannot
	// be opened with this key," full stop. Structural PEM/ASN.1 failures
	// above keep their TokenMalformed class because those are clearly
	// "this isn't an encrypted-PKCS#8 envelope at all."
	kdf := env.EncryptionAlgorithm.Parameters.KDF
	enc := env.EncryptionAlgorithm.Parameters.Cipher
	profileOK := env.EncryptionAlgorithm.Algorithm.Equal(oidPBES2) &&
		kdf.Algorithm.Equal(oidPBKDF2) &&
		kdf.Parameters.PRF.Algorithm.Equal(oidHMACWithSHA256) &&
		kdf.Parameters.KeyLength == EncryptionKeyLen &&
		kdf.Parameters.IterationCount >= 100_000 &&
		enc.Algorithm.Equal(oidAES256GCM) &&
		enc.Parameters.ICVLength == GCMTagLen &&
		len(enc.Parameters.Nonce) == GCMNonceLen
	if !profileOK {
		return nil, newError(CodeKeyDecryptionFailed,
			"encrypted PKCS#8: decryption failed", nil)
	}

	// Derive KEK and decrypt.
	kek, err := pbkdf2.Key(sha256.New, passphrase, kdf.Parameters.Salt,
		kdf.Parameters.IterationCount, kdf.Parameters.KeyLength)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCMWithTagSize(block, GCMTagLen)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, enc.Parameters.Nonce, env.EncryptedData, nil)
	if err != nil {
		// Same opaque string as the profile-mismatch branch above so error
		// logs can't be used as an oracle to distinguish which leg failed.
		return nil, newError(CodeKeyDecryptionFailed,
			"encrypted PKCS#8: decryption failed", nil)
	}
	return plaintext, nil
}
