package licensing

import (
	"errors"
	"strings"
	"testing"
)

// Codec router behaviour — the Go mirror of the TypeScript suite.
//
// These tests encode the guarantees that made the refactor necessary: a
// token belonging to another format must never reach the LIC1 parser, an
// unregistered prefix must be rejected before any byte is decoded, and a
// signature is only valid under its own format's signing-input
// construction.
//
// A stub codec stands in for a second format so none of this depends on
// LIC2 having landed.

const stubPrefix = "STUB1."

var errStubParse = errors.New("stub codec parse failure")

type stubCodec struct{}

func (stubCodec) Prefix() string { return stubPrefix }

func (stubCodec) SupportsAlg(alg KeyAlg) bool { return alg == AlgEd25519 }

func (stubCodec) Decode(token string) (DecodedEnvelope, error) {
	rest := strings.TrimPrefix(token, stubPrefix)
	parts := strings.Split(rest, "~")
	if len(parts) != 2 {
		return DecodedEnvelope{}, errStubParse
	}
	return DecodedEnvelope{
		Header:       EnvelopeHeader{Alg: AlgEd25519, Kid: "stub-kid"},
		Payload:      map[string]any{"stub": true},
		SigningInput: []byte("STUB-PAE:" + parts[0]),
		Signature:    []byte(parts[1]),
	}, nil
}

func (stubCodec) Encode(CodecEncodeInput) (string, error) {
	return "", errStubParse
}

// unregisterCodecForTesting drops a registered codec so a test can register
// a stub. Test-only: production code has no reason to unregister a format,
// so this deliberately lives here rather than in token_codec.go.
func unregisterCodecForTesting(prefix string) {
	codecMu.Lock()
	defer codecMu.Unlock()
	delete(codecs, prefix)
	for i, p := range codecOrder {
		if p == prefix {
			codecOrder = append(codecOrder[:i], codecOrder[i+1:]...)
			break
		}
	}
}

// registerStub registers the stub codec for the duration of a test.
func registerStub(t *testing.T) {
	t.Helper()
	if err := RegisterCodec(stubCodec{}); err != nil {
		t.Fatalf("registering stub codec: %v", err)
	}
	t.Cleanup(func() { unregisterCodecForTesting(stubPrefix) })
}

func TestDispatch_ForeignPrefixNeverReachesLIC1Parser(t *testing.T) {
	registerStub(t)

	// Deliberately malformed for the stub. If this reached the LIC1 parser
	// it would fail with TokenMalformed ("expected 4 dot-separated
	// segments") instead of the stub's own error — that mis-attribution is
	// exactly what the router exists to prevent.
	codec, err := CodecFor(stubPrefix + "only-one-part")
	if err != nil {
		t.Fatalf("stub prefix was not routed: %v", err)
	}
	_, err = codec.Decode(stubPrefix + "only-one-part")
	if !errors.Is(err, errStubParse) {
		t.Fatalf("expected the stub codec's own error, got %v", err)
	}
	if errors.Is(err, ErrTokenMalformed) {
		t.Fatal("foreign token produced a LIC1-shaped TokenMalformed")
	}
}

func TestDispatch_RoutesEachPrefixToItsOwner(t *testing.T) {
	registerStub(t)

	lic1, err := CodecFor("LIC1.a.b.c")
	if err != nil {
		t.Fatalf("LIC1 routing: %v", err)
	}
	if lic1.Prefix() != LIC1Prefix {
		t.Fatalf("expected LIC1 codec, got %q", lic1.Prefix())
	}

	stub, err := CodecFor(stubPrefix + "x~y")
	if err != nil {
		t.Fatalf("stub routing: %v", err)
	}
	if stub.Prefix() != stubPrefix {
		t.Fatalf("expected stub codec, got %q", stub.Prefix())
	}
}

func TestDispatch_UnregisteredPrefixRejected(t *testing.T) {
	for _, token := range []string{"v4.public.abc", "NOPE.!!!not-base64!!!", "eyJhbGciOiJub25lIn0."} {
		if _, err := CodecFor(token); !errors.Is(err, ErrUnsupportedTokenFormat) {
			t.Fatalf("token %q: expected UnsupportedTokenFormat, got %v", token, err)
		}
	}
}

func TestDispatch_ErrorClipsUnboundedInput(t *testing.T) {
	blob := strings.Repeat("A", 50_000)
	_, err := CodecFor(blob)
	if err == nil {
		t.Fatal("expected an error for an unregistered prefix")
	}
	if len(err.Error()) > 200 {
		t.Fatalf("error message was not clipped: %d bytes", len(err.Error()))
	}
	if strings.Contains(err.Error(), blob) {
		t.Fatal("error echoed the full input back")
	}
}

func TestDispatch_ErrorClipsAtFirstDot(t *testing.T) {
	_, err := CodecFor("UNKNOWN." + strings.Repeat("B", 10_000))
	if err == nil {
		t.Fatal("expected an error for an unregistered prefix")
	}
	if len(err.Error()) > 200 {
		t.Fatalf("error message was not clipped: %d bytes", len(err.Error()))
	}
}

func TestSigningInput_CrossFormatSignatureRejected(t *testing.T) {
	// fakeBackend (lic1_test.go) is deterministic, so this asserts the
	// construction difference rather than any property of a real curve.
	be := fakeBackend{}
	priv, err := be.ImportPrivate(KeyMaterial{}, "")
	if err != nil {
		t.Fatalf("import private: %v", err)
	}
	pub, err := be.ImportPublic(KeyMaterial{})
	if err != nil {
		t.Fatalf("import public: %v", err)
	}

	// Sign the LIC1-style construction...
	sig, err := be.Sign(priv, []byte("header.payload"))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	// ...then check it against the stub's construction over the same data.
	ok, err := be.Verify(pub, []byte("STUB-PAE:header.payload"), sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if ok {
		t.Fatal("a signature over one format's signing input verified under another's")
	}

	// Sanity: the same construction on both sides must verify, so the
	// assertion above is about the construction and not a broken backend.
	ok, err = be.Verify(pub, []byte("header.payload"), sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("signature failed to verify under its own signing input")
	}
}

func TestRegisterCodec_DuplicateKeepsOriginal(t *testing.T) {
	registerStub(t)

	if err := RegisterCodec(stubCodec{}); !errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("expected duplicate registration to fail, got %v", err)
	}
	codec, err := CodecFor(stubPrefix + "x~y")
	if err != nil {
		t.Fatalf("stub dispatch broke after a rejected duplicate: %v", err)
	}
	if codec.Prefix() != stubPrefix {
		t.Fatalf("expected the original stub codec, got %q", codec.Prefix())
	}
}

func TestRegisteredPrefixes_ContainsLIC1(t *testing.T) {
	found := false
	for _, p := range RegisteredPrefixes() {
		if p == LIC1Prefix {
			found = true
		}
	}
	if !found {
		t.Fatalf("LIC1 prefix missing from %v", RegisteredPrefixes())
	}
}
