package licensing

import (
	"fmt"
	"sync"
)

// Token codec registry — prefix → codec routing.
//
// Before this file existed, RegisterFormat maintained a bare list of
// permitted prefixes and every token that passed the check was handed to
// the LIC1 parser. That made a second format impossible to add safely:
// registering "v4.public." would have routed a PASETO token into the LIC1
// parser, which would then have failed with a LIC1-shaped ErrTokenMalformed
// instead of the real reason. The old code said so in a comment and told
// callers not to register anything else until this landed.
//
// A codec owns three things for its format: Decode, the signing input its
// signatures are computed over, and Encode. The signing input is per-codec
// because the constructions genuinely differ — LIC1 concatenates
// <header_b64>.<payload_b64> as ASCII, while PASETO uses PAE over a
// length-prefixed vector. Verification therefore asks the token's own codec
// and never assumes a shared shape.

// DecodedEnvelope is the common shape every codec decodes to. Header carries
// the fields verification needs regardless of format — which key, which
// algorithm — so the verify path stays format-agnostic.
type DecodedEnvelope struct {
	Payload      map[string]any
	Header       EnvelopeHeader
	SigningInput []byte
	Signature    []byte
}

// EnvelopeHeader is the format-agnostic subset of a token header.
type EnvelopeHeader struct {
	Alg KeyAlg
	Kid string
}

// CodecEncodeInput carries what a codec needs to produce a token.
type CodecEncodeInput struct {
	PrivateKey PrivateKeyHandle
	Backend    SignatureBackend
	Payload    map[string]any
	Kid        string
	Alg        KeyAlg
}

// TokenCodec is one token format. Implementations must not read or parse
// tokens that do not carry their own prefix.
type TokenCodec interface {
	// Prefix is the ASCII prefix this codec owns, including the trailing
	// separator.
	Prefix() string
	// SupportsAlg reports whether this codec can sign and verify with alg. A
	// codec supporting fewer algorithms than the system as a whole (LIC2 is
	// Ed25519-only) reports that here so callers can reject early.
	SupportsAlg(alg KeyAlg) bool
	// Decode parses without verifying, returning this codec's own errors.
	Decode(token string) (DecodedEnvelope, error)
	// Encode builds a signed token.
	Encode(input CodecEncodeInput) (string, error)
}

// TokenFormat names a selectable token envelope.
//
// A name rather than a prefix, because the prefix is an encoding detail
// (LIC2 is written "v4.public." on the wire) and callers should not have to
// know it to choose a format.
type TokenFormat string

// TokenFormat values.
const (
	FormatLIC1 TokenFormat = "LIC1"
	FormatLIC2 TokenFormat = "LIC2"
)

// formatPrefix maps a selectable format to the wire prefix its codec owns.
var formatPrefix = map[TokenFormat]string{
	FormatLIC1: LIC1Prefix,
	FormatLIC2: LIC2Prefix,
}

// CodecForFormat resolves a format name to its registered codec.
//
// An unregistered codec means the package defining it was never linked in —
// a wiring bug rather than bad input.
func CodecForFormat(format TokenFormat) (TokenCodec, error) {
	prefix, ok := formatPrefix[format]
	if !ok {
		return nil, newError(CodeUnsupportedTokenFormat,
			fmt.Sprintf("unknown token format: %s", format),
			map[string]any{"format": string(format)})
	}
	codecMu.RLock()
	defer codecMu.RUnlock()
	codec, ok := codecs[prefix]
	if !ok {
		return nil, newError(CodeUnsupportedTokenFormat,
			fmt.Sprintf("token format %s is not registered", format),
			map[string]any{"format": string(format)})
	}
	return codec, nil
}

var (
	codecMu sync.RWMutex
	codecs  = map[string]TokenCodec{}
	// codecOrder preserves registration order so dispatch is deterministic
	// regardless of map iteration order.
	codecOrder []string
)

// RegisterCodec registers a codec under its prefix. Duplicate registration
// is rejected so a second registration cannot silently displace the first —
// the previously registered codec stays in effect.
func RegisterCodec(codec TokenCodec) error {
	codecMu.Lock()
	defer codecMu.Unlock()
	prefix := codec.Prefix()
	if _, exists := codecs[prefix]; exists {
		return newError(CodeUnsupportedTokenFormat,
			fmt.Sprintf("format prefix already registered: %s", prefix),
			map[string]any{"prefix": prefix})
	}
	codecs[prefix] = codec
	codecOrder = append(codecOrder, prefix)
	return nil
}

// RegisteredPrefixes returns the registered prefixes, for diagnostics and
// tests.
func RegisteredPrefixes() []string {
	codecMu.RLock()
	defer codecMu.RUnlock()
	out := make([]string, len(codecOrder))
	copy(out, codecOrder)
	return out
}

// CodecFor selects the codec owning this token's prefix.
//
// An unregistered prefix is rejected before any base64 decoding, payload
// parsing, or signature verification happens. The error names the offending
// prefix clipped to a bounded length, so a caller pasting a large binary
// blob cannot expand the log line.
func CodecFor(token string) (TokenCodec, error) {
	codecMu.RLock()
	defer codecMu.RUnlock()
	for _, prefix := range codecOrder {
		if len(token) >= len(prefix) && token[:len(prefix)] == prefix {
			return codecs[prefix], nil
		}
	}
	return nil, newError(CodeUnsupportedTokenFormat,
		fmt.Sprintf("unsupported token format: %s", clipPrefix(token)),
		map[string]any{"prefix": clipPrefix(token)})
}

// clipPrefix extracts a plausible prefix for an error message — everything
// up to and including the first dot, or the first 16 bytes when there is no
// dot. Bounded so a binary blob cannot blow up a log line.
func clipPrefix(token string) string {
	for i := 0; i < len(token) && i <= 16; i++ {
		if token[i] == '.' {
			return token[:i+1]
		}
	}
	if len(token) > 16 {
		return token[:16]
	}
	return token
}
