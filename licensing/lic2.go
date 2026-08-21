package licensing

import (
	"fmt"
	"strings"
)

// LIC2 token envelope: PASETO v4.public.
//
//	v4.public.<base64url(message || signature)>.<base64url(footer)>
//
// LIC2 is the second registered token format. Unlike LIC1 — which carries a
// header segment naming alg and kid — PASETO deliberately forbids algorithm
// agility: the version string IS the algorithm commitment. v4 means Ed25519,
// always. There is no header field an attacker can tamper with to select a
// weaker primitive.
//
// Because there is no header, the kid travels in the PASETO footer, which is
// authenticated (it is fed into PAE) but not encrypted. That is the standard
// place for key identification and is what lets a verifier select a key
// before checking the signature.
//
// Implementation note: v4.public is Ed25519 over a PAE-encoded string and
// nothing more, so the signing primitive comes from the same backend LIC1
// uses rather than a third-party PASETO library. The TypeScript port makes
// the same choice, which keeps the two implementations symmetric: a
// cross-port divergence is a real format bug rather than two libraries
// disagreeing. Conformance against an independent implementation is asserted
// in the TypeScript suite.

// LIC2Prefix is the ASCII prefix the LIC2 codec owns. PASETO's header
// includes the trailing dot.
const LIC2Prefix = "v4.public."

// ed25519SigLen is the Ed25519 detached signature length.
const ed25519SigLen = 64

// le64 encodes n as a 64-bit unsigned little-endian length.
//
// The spec requires the most significant bit to be cleared, "for
// interoperability with programming languages that do not have unsigned
// integer support". Lengths that large are unreachable here, but the
// clearing is part of the encoding and is applied unconditionally.
func le64(n int) []byte {
	out := make([]byte, 8)
	v := uint64(n) //nolint:gosec // n is a slice length, never negative
	for i := range out {
		out[i] = byte(v & 0xff)
		v >>= 8
	}
	out[7] &= 0x7f
	return out
}

// PAE is the PASETO Pre-Authentication Encoding:
//
//	LE64(count) || (LE64(len(piece)) || piece)...
//
// The length prefixes are what make the encoding unambiguous: two different
// piece vectors cannot produce the same byte string, so an attacker cannot
// shift bytes between the header, payload, footer, and implicit assertion.
func PAE(pieces ...[]byte) []byte {
	total := 8
	for _, p := range pieces {
		total += 8 + len(p)
	}
	out := make([]byte, 0, total)
	out = append(out, le64(len(pieces))...)
	for _, p := range pieces {
		out = append(out, le64(len(p))...)
		out = append(out, p...)
	}
	return out
}

// lic2SigningInput builds the bytes a v4.public signature covers:
// PAE([h, m, f, i]) where i (the implicit assertion) is empty for LIC2.
func lic2SigningInput(message, footer []byte) []byte {
	return PAE([]byte(LIC2Prefix), message, footer, nil)
}

type lic2CodecImpl struct{}

// LIC2Codec is the registered LIC2 codec.
var LIC2Codec TokenCodec = lic2CodecImpl{}

// Prefix returns the ASCII prefix the LIC2 codec owns.
func (lic2CodecImpl) Prefix() string { return LIC2Prefix }

// SupportsAlg reports whether LIC2 can carry alg.
//
// LIC2 is Ed25519-only. This is not a project restriction but a property of
// PASETO: a v4 token commits to Ed25519 by its version string. There is no
// v4 encoding for RSA-PSS, and the symmetric mode (v4.local) is a different
// purpose with different security properties, deliberately out of scope.
func (lic2CodecImpl) SupportsAlg(alg KeyAlg) bool { return alg == AlgEd25519 }

// Decode parses a LIC2 token without verifying its signature. The prefix is
// assumed to have been matched by the router.
func (lic2CodecImpl) Decode(token string) (DecodedEnvelope, error) {
	var zero DecodedEnvelope
	rest := strings.TrimPrefix(token, LIC2Prefix)
	if rest == "" {
		return zero, newError(CodeTokenMalformed, "LIC2 token has no payload segment", nil)
	}

	// At most one footer segment. PASETO tokens are h.payload[.footer], and
	// the header already consumed its own dots, so anything beyond a single
	// separator here is malformed.
	segments := strings.Split(rest, ".")
	if len(segments) > 2 {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("LIC2 token has %d segments after the header, expected 1 or 2", len(segments)),
			nil)
	}

	body, err := Base64urlDecode(segments[0])
	if err != nil {
		return zero, err
	}
	if len(body) <= ed25519SigLen {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("LIC2 payload is %d bytes, too short to contain a %d-byte signature",
				len(body), ed25519SigLen),
			nil)
	}
	message := body[:len(body)-ed25519SigLen]
	signature := body[len(body)-ed25519SigLen:]

	var footerBytes []byte
	if len(segments) == 2 {
		footerBytes, err = Base64urlDecode(segments[1])
		if err != nil {
			return zero, err
		}
	}
	if len(footerBytes) == 0 {
		return zero, newError(CodeTokenMalformed, "LIC2 requires a footer carrying kid", nil)
	}

	footer, err := parseJSONObject(footerBytes, "footer")
	if err != nil {
		return zero, err
	}
	kid, ok := footer["kid"].(string)
	if !ok || kid == "" {
		return zero, newError(CodeTokenMalformed,
			"LIC2 footer.kid must be a non-empty string", nil)
	}

	payload, err := parseJSONObject(message, "payload")
	if err != nil {
		return zero, err
	}

	return DecodedEnvelope{
		Header:       EnvelopeHeader{Alg: AlgEd25519, Kid: kid},
		Payload:      payload,
		SigningInput: lic2SigningInput(message, footerBytes),
		Signature:    signature,
	}, nil
}

// Encode builds a signed LIC2 token.
func (lic2CodecImpl) Encode(input CodecEncodeInput) (string, error) {
	if input.Alg != AlgEd25519 {
		return "", newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("LIC2 (PASETO v4.public) supports ed25519 only, got %s — "+
				"either switch the signing algorithm to ed25519, or issue LIC1 tokens instead",
				input.Alg),
			map[string]any{"alg": string(input.Alg)})
	}

	// Canonical JSON keeps LIC2 byte-comparable across ports, exactly as it
	// does for LIC1. PASETO does not mandate a serialisation, so without
	// this the two ports could emit equivalent-but-different JSON.
	message, err := Canonicalize(map[string]any(input.Payload))
	if err != nil {
		return "", err
	}
	footer, err := Canonicalize(map[string]any{"kid": input.Kid})
	if err != nil {
		return "", err
	}

	sig, err := input.Backend.Sign(input.PrivateKey, lic2SigningInput(message, footer))
	if err != nil {
		return "", err
	}

	body := make([]byte, 0, len(message)+len(sig))
	body = append(body, message...)
	body = append(body, sig...)

	var b strings.Builder
	b.WriteString(LIC2Prefix)
	b.WriteString(Base64urlEncode(body))
	b.WriteByte('.')
	b.WriteString(Base64urlEncode(footer))
	return b.String(), nil
}

func init() {
	if err := RegisterCodec(LIC2Codec); err != nil {
		panic("licensing: registering the LIC2 codec: " + err.Error())
	}
}
