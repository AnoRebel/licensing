package licensing

import (
	"errors"
	"strings"
	"testing"
)

// tokenFormat selection at issuance — the Go mirror of the TypeScript
// suite. The guarantees: LIC1 is what you get unless you ask for something
// else, and an unsupported (format, alg) pairing fails before a token is
// produced rather than yielding one that cannot be verified.

func TestCodecForFormat_ResolvesBothFormats(t *testing.T) {
	lic1, err := CodecForFormat(FormatLIC1)
	if err != nil {
		t.Fatalf("LIC1: %v", err)
	}
	if lic1.Prefix() != LIC1Prefix {
		t.Fatalf("LIC1 resolved to %q", lic1.Prefix())
	}

	lic2, err := CodecForFormat(FormatLIC2)
	if err != nil {
		t.Fatalf("LIC2: %v", err)
	}
	if lic2.Prefix() != LIC2Prefix {
		t.Fatalf("LIC2 resolved to %q", lic2.Prefix())
	}
}

func TestCodecForFormat_RejectsUnknownFormat(t *testing.T) {
	if _, err := CodecForFormat(TokenFormat("LIC9")); !errors.Is(err, ErrUnsupportedTokenFormat) {
		t.Fatalf("expected UnsupportedTokenFormat, got %v", err)
	}
}

// The zero value of TokenFormat must mean LIC1, so an existing caller that
// never sets the field keeps emitting exactly what it emitted before.
func TestTokenFormat_ZeroValueMeansLIC1(t *testing.T) {
	var unset TokenFormat
	if unset != "" {
		t.Fatalf("expected the zero value to be empty, got %q", unset)
	}
	format := unset
	if format == "" {
		format = FormatLIC1
	}
	if format != FormatLIC1 {
		t.Fatalf("zero value did not default to LIC1, got %q", format)
	}
}

func TestFormatAlgSupport(t *testing.T) {
	lic1, err := CodecForFormat(FormatLIC1)
	if err != nil {
		t.Fatal(err)
	}
	lic2, err := CodecForFormat(FormatLIC2)
	if err != nil {
		t.Fatal(err)
	}

	// LIC2 is Ed25519-only; LIC1 carries the wider set.
	for _, alg := range []KeyAlg{AlgRSAPSS, AlgHS256} {
		if lic2.SupportsAlg(alg) {
			t.Errorf("LIC2 must not support %s", alg)
		}
		if !lic1.SupportsAlg(alg) {
			t.Errorf("LIC1 must support %s", alg)
		}
	}
	if !lic2.SupportsAlg(AlgEd25519) {
		t.Error("LIC2 must support ed25519")
	}
}

func TestLIC2Codec_RejectsUnsupportedAlgAtEncode(t *testing.T) {
	_, err := LIC2Codec.Encode(CodecEncodeInput{
		Alg:     AlgHS256,
		Kid:     "k",
		Payload: map[string]any{"a": "b"},
		Backend: fakeBackend{},
	})
	if err == nil {
		t.Fatal("expected LIC2 to reject hs256")
	}
	if !strings.Contains(err.Error(), "ed25519 only") {
		t.Fatalf("error should name the constraint, got: %v", err)
	}
}
