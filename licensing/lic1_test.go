package licensing

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------
// DecodeUnverified — happy path via fixtures
// -----------------------------------------------------------------------

func TestDecodeUnverified_Fixture(t *testing.T) {
	root := repoRoot(t)
	tokenPath := filepath.Join(root, "fixtures", "tokens",
		"001-ed25519-active", "expected_token.txt")
	raw, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	token := strings.TrimRight(string(raw), "\n")

	parts, err := DecodeUnverified(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if parts.Header.V != 1 || parts.Header.Typ != "lic" ||
		parts.Header.Alg != AlgEd25519 || parts.Header.Kid != "fixture-ed25519-1" {
		t.Fatalf("unexpected header: %+v", parts.Header)
	}
	// Payload should round-trip the jti we know lives in this fixture.
	if got := parts.Payload["jti"]; got != "jti-active-0" {
		t.Fatalf("unexpected payload.jti: %v", got)
	}
	// Signing input = <header_b64>.<payload_b64> — must equal the first two
	// segments joined by a dot, in ASCII.
	segs := strings.Split(token, ".")
	want := segs[1] + "." + segs[2]
	if string(parts.SigningInput) != want {
		t.Fatalf("signing input drift\nwant %q\n got %q", want, string(parts.SigningInput))
	}
}

// -----------------------------------------------------------------------
// Format dispatch — 8.3a negative tests
// -----------------------------------------------------------------------

func TestDispatchFormat_RejectsUnknownPrefix(t *testing.T) {
	// A PASETO-style v4.public token has never been registered and must fail
	// at the dispatch layer, before any base64/JSON decoding is attempted.
	pasetoIsh := "v4.public.eyJhbGciOiJFZERTQSJ9.aGVsbG8.c2ln"
	_, err := DecodeUnverified(pasetoIsh)
	if err == nil {
		t.Fatal("expected UnsupportedTokenFormat, got nil")
	}
	if !errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("expected UnsupportedTokenFormat, got %v", err)
	}
}

func TestDispatchFormat_RejectsJWT(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.aGVsbG8"
	_, err := DecodeUnverified(jwt)
	if !errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("expected UnsupportedTokenFormat, got %v", err)
	}
}

func TestRegisterFormat_RejectsDuplicate(t *testing.T) {
	err := RegisterFormat("LIC1.")
	if err == nil {
		t.Fatal("expected error for duplicate LIC1. registration")
	}
	if !errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("expected UnsupportedTokenFormat, got %v", err)
	}
}

func TestRegisterFormat_AcceptsNewPrefix(t *testing.T) {
	// Register a dummy LIC9 prefix. dispatchFormat now allowlists it, so the
	// codec-level failure shifts from UnsupportedTokenFormat to TokenMalformed
	// (the LIC1 shape check further downstream). The registry is an
	// allowlist, not a parser router — see the future-LIC2 comment in lic1.go.
	err := RegisterFormat("LIC9.")
	if err != nil {
		t.Fatal(err)
	}
	_, err = DecodeUnverified("LIC9.stub")
	if errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("LIC9. prefix was still rejected as UnsupportedTokenFormat: %v", err)
	}
}

// -----------------------------------------------------------------------
// Segment layout / shape errors
// -----------------------------------------------------------------------

func TestDecodeUnverified_WrongSegmentCount(t *testing.T) {
	_, err := DecodeUnverified("LIC1.aaa.bbb") // 3 segments
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestDecodeUnverified_Base64PaddingRejected(t *testing.T) {
	_, err := DecodeUnverified("LIC1.eyJ2IjoxfQ==.eyJ9.c2ln")
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestDecodeUnverified_Base64InvalidChars(t *testing.T) {
	_, err := DecodeUnverified("LIC1.eyJ@.eyJ9.c2ln") // '@' is not base64url
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Header whitelist & validation
// -----------------------------------------------------------------------

func buildToken(t *testing.T, headerJSON, payloadJSON string) string {
	t.Helper()
	hb := Base64urlEncode([]byte(headerJSON))
	pb := Base64urlEncode([]byte(payloadJSON))
	sb := Base64urlEncode([]byte("stub-signature"))
	return "LIC1." + hb + "." + pb + "." + sb
}

func TestParseHeader_UnknownField(t *testing.T) {
	tok := buildToken(t,
		`{"v":1,"typ":"lic","alg":"ed25519","kid":"k","extra":"nope"}`,
		`{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestParseHeader_MissingField(t *testing.T) {
	tok := buildToken(t, `{"v":1,"typ":"lic","alg":"ed25519"}`, `{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestParseHeader_BadVersion(t *testing.T) {
	tok := buildToken(t,
		`{"v":2,"typ":"lic","alg":"ed25519","kid":"k"}`,
		`{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestParseHeader_BadTyp(t *testing.T) {
	tok := buildToken(t,
		`{"v":1,"typ":"jwt","alg":"ed25519","kid":"k"}`,
		`{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestParseHeader_UnknownAlg(t *testing.T) {
	tok := buildToken(t,
		`{"v":1,"typ":"lic","alg":"none","kid":"k"}`,
		`{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrUnsupportedAlgorithm) {
		t.Fatalf("expected UnsupportedAlgorithm, got %v", err)
	}
}

func TestParseHeader_EmptyKid(t *testing.T) {
	tok := buildToken(t,
		`{"v":1,"typ":"lic","alg":"ed25519","kid":""}`,
		`{}`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestParsePayload_NotObject(t *testing.T) {
	tok := buildToken(t,
		`{"v":1,"typ":"lic","alg":"ed25519","kid":"k"}`,
		`["array","payload"]`)
	_, err := DecodeUnverified(tok)
	if !errors.Is(err, ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Encode round-trip + Verify using a fake backend
// -----------------------------------------------------------------------

// fakeBackend is a minimal SignatureBackend used to exercise Encode/Verify
// without depending on the real ed25519 impl. It produces a deterministic
// HMAC-ish MAC over the signing input plus a fixed secret.
type fakeBackend struct{}

func (fakeBackend) Alg() KeyAlg { return AlgEd25519 }
func (fakeBackend) ImportPrivate(_ KeyMaterial, _ string) (PrivateKeyHandle, error) {
	return struct{}{}, nil
}
func (fakeBackend) ImportPublic(_ KeyMaterial) (PublicKeyHandle, error) {
	return struct{}{}, nil
}
func (fakeBackend) Sign(_ PrivateKeyHandle, data []byte) ([]byte, error) {
	h := sha256.Sum256(append([]byte("fake-secret:"), data...))
	return h[:], nil
}
func (fakeBackend) Verify(_ PublicKeyHandle, data, sig []byte) (bool, error) {
	h := sha256.Sum256(append([]byte("fake-secret:"), data...))
	return bytes.Equal(h[:], sig), nil
}
func (fakeBackend) Generate(_ string) (PemKeyMaterial, RawKeyMaterial, error) {
	return PemKeyMaterial{}, RawKeyMaterial{}, nil
}

func TestEncodeVerify_RoundTrip(t *testing.T) {
	be := fakeBackend{}
	tok, err := Encode(EncodeOptions{
		Header: LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: AlgEd25519,
			Kid: "test-kid-1",
		},
		Payload: LIC1Payload{
			"jti":   "round-trip",
			"iat":   int64(1700000000),
			"scope": "test",
		},
		PrivateKey: struct{}{},
		Backend:    be,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !strings.HasPrefix(tok, "LIC1.") {
		t.Fatalf("token missing LIC1. prefix: %q", tok)
	}

	// Build the verify deps.
	reg := NewAlgorithmRegistry()
	if err := reg.Register(be); err != nil {
		t.Fatal(err)
	}
	bindings := NewKeyAlgBindings()
	if err := bindings.Bind("test-kid-1", AlgEd25519); err != nil {
		t.Fatal(err)
	}
	keys := map[string]KeyRecord{
		"test-kid-1": {Kid: "test-kid-1", Alg: AlgEd25519},
	}

	parts, err := Verify(tok, VerifyOptions{Registry: reg, Bindings: bindings, Keys: keys})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if parts.Header.Kid != "test-kid-1" {
		t.Fatalf("header kid drift: %q", parts.Header.Kid)
	}
}

func TestVerify_DetectsTampering(t *testing.T) {
	be := fakeBackend{}
	tok, err := Encode(EncodeOptions{
		Header:     LIC1Header{V: 1, Typ: "lic", Alg: AlgEd25519, Kid: "k"},
		Payload:    LIC1Payload{"jti": "t"},
		PrivateKey: struct{}{},
		Backend:    be,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Flip a byte in the signature segment.
	segs := strings.Split(tok, ".")
	raw, _ := Base64urlDecode(segs[3])
	raw[0] ^= 0x01
	segs[3] = Base64urlEncode(raw)
	tampered := strings.Join(segs, ".")

	reg := NewAlgorithmRegistry()
	_ = reg.Register(be)
	bindings := NewKeyAlgBindings()
	_ = bindings.Bind("k", AlgEd25519)
	keys := map[string]KeyRecord{"k": {Kid: "k", Alg: AlgEd25519}}

	_, err = Verify(tampered, VerifyOptions{Registry: reg, Bindings: bindings, Keys: keys})
	if !errors.Is(err, ErrTokenSignatureInvalid) {
		t.Fatalf("expected TokenSignatureInvalid, got %v", err)
	}
}

func TestVerify_AlgConfusionBlockedBeforeBackend(t *testing.T) {
	// If a token's header says alg=hs256 but the pre-registered (kid, alg)
	// says ed25519, we must reject with AlgorithmMismatch BEFORE calling any
	// backend verify. Simulate it by hand-crafting the token.
	tok := buildToken(t,
		`{"v":1,"typ":"lic","alg":"hs256","kid":"k"}`,
		`{"jti":"x"}`)

	reg := NewAlgorithmRegistry()
	_ = reg.Register(fakeBackend{}) // registers ed25519; hs256 not registered
	bindings := NewKeyAlgBindings()
	_ = bindings.Bind("k", AlgEd25519)
	keys := map[string]KeyRecord{"k": {Kid: "k", Alg: AlgEd25519}}

	_, err := Verify(tok, VerifyOptions{Registry: reg, Bindings: bindings, Keys: keys})
	if !errors.Is(err, ErrAlgorithmMismatch) {
		t.Fatalf("expected AlgorithmMismatch, got %v", err)
	}
}

func TestVerify_UnknownKid(t *testing.T) {
	be := fakeBackend{}
	tok, _ := Encode(EncodeOptions{
		Header:     LIC1Header{V: 1, Typ: "lic", Alg: AlgEd25519, Kid: "unbound"},
		Payload:    LIC1Payload{"jti": "t"},
		PrivateKey: struct{}{},
		Backend:    be,
	})
	reg := NewAlgorithmRegistry()
	_ = reg.Register(be)
	bindings := NewKeyAlgBindings() // no bindings
	keys := map[string]KeyRecord{}
	_, err := Verify(tok, VerifyOptions{Registry: reg, Bindings: bindings, Keys: keys})
	if !errors.Is(err, ErrUnknownKid) {
		t.Fatalf("expected UnknownKid, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Sanity — expected_token.txt matches Encode() output given known inputs.
// For the ed25519 fixture we can't reproduce this without the ed25519
// backend, so here we only assert the canonical headers/payloads
// round-trip through base64url back to the expected bytes.
// -----------------------------------------------------------------------

func TestFixtureTokenBase64urlSegments(t *testing.T) {
	root := repoRoot(t)
	name := "001-ed25519-active"
	tokBytes, err := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "expected_token.txt"))
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimRight(string(tokBytes), "\n")
	segs := strings.Split(token, ".")
	if len(segs) != 4 || segs[0] != "LIC1" {
		t.Fatalf("bad fixture token shape")
	}
	// Segment 1 should base64url-decode to canonical_header.bin; segment 2
	// to canonical_payload.bin.
	h, err := Base64urlDecode(segs[1])
	if err != nil {
		t.Fatal(err)
	}
	p, err := Base64urlDecode(segs[2])
	if err != nil {
		t.Fatal(err)
	}
	wantH, _ := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "canonical_header.bin"))
	wantP, _ := os.ReadFile(filepath.Join(root, "fixtures", "tokens", name, "canonical_payload.bin"))
	if !bytes.Equal(h, wantH) {
		t.Fatalf("header b64 segment does not match canonical_header.bin\n%s\nvs\n%s",
			hex.EncodeToString(h), hex.EncodeToString(wantH))
	}
	if !bytes.Equal(p, wantP) {
		t.Fatalf("payload b64 segment does not match canonical_payload.bin")
	}
}
