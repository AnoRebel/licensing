package licensing

import (
	"encoding/hex"
	"testing"
)

// PAE vectors from the PASETO specification (Common.md). The TypeScript port
// asserts the same vectors, so a divergence in either port fails locally
// before it can reach the cross-port suite.
func TestPAE_SpecVectors(t *testing.T) {
	cases := []struct {
		name   string
		want   string
		pieces [][]byte
	}{
		{name: "empty piece list", pieces: nil, want: "0000000000000000"},
		{name: "one empty piece", pieces: [][]byte{{}}, want: "01000000000000000000000000000000"},
		{
			name:   "one test piece",
			pieces: [][]byte{[]byte("test")},
			want:   "0100000000000000" + "0400000000000000" + "74657374",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := hex.EncodeToString(PAE(tc.pieces...))
			if got != tc.want {
				t.Fatalf("PAE mismatch:\n got=%s\nwant=%s", got, tc.want)
			}
		})
	}
}

// The length prefixes are what stop bytes being shifted between pieces.
func TestPAE_IsUnambiguous(t *testing.T) {
	a := hex.EncodeToString(PAE([]byte("a"), []byte("bb")))
	b := hex.EncodeToString(PAE([]byte("ab"), []byte("b")))
	if a == b {
		t.Fatal("PAE collided on two different piece vectors")
	}
}

func TestLE64_ClearsMostSignificantBit(t *testing.T) {
	out := PAE(make([]byte, 300))
	if out[7]&0x80 != 0 || out[15]&0x80 != 0 {
		t.Fatal("LE64 did not clear the most significant bit")
	}
	// 300 = 0x012c, little-endian across the first two octets.
	if out[8] != 0x2c || out[9] != 0x01 {
		t.Fatalf("LE64 length encoding wrong: %02x %02x", out[8], out[9])
	}
}

func TestLIC2_RejectsNonEd25519(t *testing.T) {
	_, err := LIC2Codec.Encode(CodecEncodeInput{
		Alg:     AlgRSAPSS,
		Kid:     "k",
		Payload: map[string]any{},
		Backend: fakeBackend{},
	})
	if err == nil {
		t.Fatal("expected LIC2 to reject a non-ed25519 algorithm")
	}
}

// lic2FakeBackend produces a 64-byte signature so the codec's
// fixed-width split is exercised. fakeBackend emits a 32-byte SHA-256,
// which would leave 32 bytes of signature inside the payload slice.
type lic2FakeBackend struct{ fakeBackend }

func (b lic2FakeBackend) Sign(k PrivateKeyHandle, data []byte) ([]byte, error) {
	half, err := b.fakeBackend.Sign(k, data)
	if err != nil {
		return nil, err
	}
	return append(append([]byte{}, half...), half...), nil
}

func (b lic2FakeBackend) Verify(k PublicKeyHandle, data, sig []byte) (bool, error) {
	if len(sig) != ed25519SigLen {
		return false, nil
	}
	return b.fakeBackend.Verify(k, data, sig[:len(sig)/2])
}

func TestLIC2_RoundTripThroughCodec(t *testing.T) {
	be := lic2FakeBackend{}
	priv, err := be.ImportPrivate(KeyMaterial{}, "")
	if err != nil {
		t.Fatalf("import private: %v", err)
	}
	token, err := LIC2Codec.Encode(CodecEncodeInput{
		Alg:        AlgEd25519,
		Kid:        "round-trip-kid",
		Payload:    map[string]any{"license_id": "lic-1", "scope": "example.app"},
		PrivateKey: priv,
		Backend:    be,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	codec, err := CodecFor(token)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if codec.Prefix() != LIC2Prefix {
		t.Fatalf("expected LIC2 codec, got %q", codec.Prefix())
	}

	env, err := codec.Decode(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Header.Kid != "round-trip-kid" {
		t.Fatalf("kid: got %q", env.Header.Kid)
	}
	if env.Header.Alg != AlgEd25519 {
		t.Fatalf("alg: got %q", env.Header.Alg)
	}
	if got := env.Payload["license_id"]; got != "lic-1" {
		t.Fatalf("license_id: got %v", got)
	}
	if len(env.Signature) != ed25519SigLen {
		t.Fatalf("signature length: got %d", len(env.Signature))
	}

	// The signing input must verify under the same backend that produced it.
	pub, err := be.ImportPublic(KeyMaterial{})
	if err != nil {
		t.Fatalf("import public: %v", err)
	}
	ok, err := be.Verify(pub, env.SigningInput, env.Signature)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("LIC2 signature did not verify under its own signing input")
	}
}

func TestLIC2_RejectsMissingFooter(t *testing.T) {
	// A payload long enough to hold a signature but with no footer segment.
	body := make([]byte, ed25519SigLen+8)
	copy(body, []byte(`{"a":1}`))
	token := LIC2Prefix + Base64urlEncode(body)
	if _, err := LIC2Codec.Decode(token); err == nil {
		t.Fatal("expected a missing footer to be rejected")
	}
}

func TestLIC2_RejectsShortPayload(t *testing.T) {
	token := LIC2Prefix + Base64urlEncode([]byte("short")) + "." + Base64urlEncode([]byte(`{"kid":"k"}`))
	if _, err := LIC2Codec.Decode(token); err == nil {
		t.Fatal("expected a too-short payload to be rejected")
	}
}
