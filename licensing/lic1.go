package licensing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

// KeyAlg enumerates the signing algorithms supported by LIC1 tokens. The set
// is closed: a LIC1 token that names an alg outside this list is rejected
// with ErrUnsupportedAlgorithm before any backend lookup.
type KeyAlg string

// KeyAlg values. Ed25519 is the production default; RSA-PSS (RSASSA-PSS over
// SHA-256) is provided for legacy interop; HS256 is symmetric and intended
// only for tests and dev fixtures.
const (
	AlgEd25519 KeyAlg = "ed25519"
	AlgRSAPSS  KeyAlg = "rs256-pss"
	AlgHS256   KeyAlg = "hs256"
)

// LIC1Header is the strict, 4-field token header. Unknown fields in the
// decoded bytes are rejected as ErrTokenMalformed.
type LIC1Header struct {
	Typ string `json:"typ"`
	Alg KeyAlg `json:"alg"`
	Kid string `json:"kid"`
	V   int    `json:"v"`
}

// LIC1Payload is treated as an opaque object by the codec. The domain layer
// enforces its schema; the codec only requires it to canonicalize and parse
// as a JSON object.
type LIC1Payload map[string]any

// LIC1DecodedParts carries the result of a shallow (unverified) decode. The
// signingInput is pre-computed because callers that verify it must feed the
// EXACT bytes that were signed — re-deriving it later risks drift.
type LIC1DecodedParts struct {
	Header       LIC1Header
	Payload      LIC1Payload
	SigningInput []byte
	Signature    []byte
}

// -----------------------------------------------------------------------
// Encode
// -----------------------------------------------------------------------

// EncodeOptions drives LIC1 token assembly. The caller supplies a backend
// and the private key handle appropriate for it.
type EncodeOptions struct {
	PrivateKey PrivateKeyHandle
	Backend    SignatureBackend
	Payload    LIC1Payload
	Header     LIC1Header
}

// Encode builds a LIC1 token from its constituent parts. It canonicalizes
// the header and payload, base64url-encodes both, constructs the
// `<header_b64>.<payload_b64>` signing input, signs it with the supplied
// backend, and returns the four-segment dot-joined token string.
func Encode(opts EncodeOptions) (string, error) {
	headerMap, err := headerToMap(opts.Header)
	if err != nil {
		return "", err
	}
	headerBytes, err := Canonicalize(headerMap)
	if err != nil {
		return "", err
	}
	payloadBytes, err := Canonicalize(map[string]any(opts.Payload))
	if err != nil {
		return "", err
	}
	headerB64 := Base64urlEncode(headerBytes)
	payloadB64 := Base64urlEncode(payloadBytes)
	signingInput := []byte(headerB64 + "." + payloadB64)
	sig, err := opts.Backend.Sign(opts.PrivateKey, signingInput)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.Grow(len("LIC1.") + len(headerB64) + 1 + len(payloadB64) + 1 + len(sig)*2)
	b.WriteString("LIC1.")
	b.WriteString(headerB64)
	b.WriteByte('.')
	b.WriteString(payloadB64)
	b.WriteByte('.')
	b.WriteString(Base64urlEncode(sig))
	return b.String(), nil
}

func headerToMap(h LIC1Header) (map[string]any, error) {
	// Build the map in a way that produces the exact JSON shape the
	// canonicalizer expects (numbers as int64, alg as string).
	return map[string]any{
		"v":   int64(h.V),
		"typ": h.Typ,
		"alg": string(h.Alg),
		"kid": h.Kid,
	}, nil
}

// -----------------------------------------------------------------------
// Decode (unverified) + format dispatch
// -----------------------------------------------------------------------

// DecodeUnverified performs a shallow parse of a LIC1 token: format prefix
// check, segment layout check, base64url decode, JSON parse, strict header
// whitelist. It does NOT verify the signature — use Verify for that. Use
// this for introspection of untrusted tokens where a verification failure
// would short-circuit the parse.
func DecodeUnverified(token string) (LIC1DecodedParts, error) {
	var zero LIC1DecodedParts
	if err := dispatchFormat(token); err != nil {
		return zero, err
	}
	parts := strings.Split(token, ".")
	if len(parts) != 4 {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("expected 4 dot-separated segments, got %d", len(parts)),
			nil)
	}
	headerB64, payloadB64, sigB64 := parts[1], parts[2], parts[3]

	headerBytes, err := Base64urlDecode(headerB64)
	if err != nil {
		return zero, err
	}
	payloadBytes, err := Base64urlDecode(payloadB64)
	if err != nil {
		return zero, err
	}
	sig, err := Base64urlDecode(sigB64)
	if err != nil {
		return zero, err
	}
	header, err := parseHeader(headerBytes)
	if err != nil {
		return zero, err
	}
	payload, err := parsePayload(payloadBytes)
	if err != nil {
		return zero, err
	}
	return LIC1DecodedParts{
		Header:       header,
		Payload:      payload,
		SigningInput: []byte(headerB64 + "." + payloadB64),
		Signature:    sig,
	}, nil
}

// Format-prefix ALLOWLIST. The only entry today is "LIC1."; any other
// prefix (`v4.public.`, JWT-style `eyJ...`, `LIC2.`, etc.) is rejected
// before we touch the bytes.
//
// This registry is intentionally prefix-only — it does NOT route to
// different parsers. DecodeUnverified below is the only parser, and it
// is LIC1-specific. Registering a non-LIC1 prefix here would let a token
// *reach* the LIC1 parser, which would then fail with a wrong
// TokenMalformed code. Do NOT register a non-LIC1 prefix until the
// broader token-codec refactor lands.
//
// ────────────────────────────────────────────────────────────────────
// Future LIC2 / PASETO seam:
// When we add a second token format, lift LIC1DecodedParts to an
// interface that each codec implements, and turn this allowlist into a
// real parser router — RegisterFormat(prefix, parseFn) where parseFn
// returns the common envelope type. Verify will also need its own
// dispatch because the signing-input construction differs per codec
// (LIC1 concatenates `<h>.<p>` ASCII; PASETO uses PAE).
// ────────────────────────────────────────────────────────────────────
var (
	formatMu       sync.RWMutex
	formatPrefixes = []string{"LIC1."}
)

// RegisterFormat adds prefix to the allowlist. Registering a duplicate
// prefix returns ErrUnsupportedTokenFormat. A registered prefix is the
// necessary-but-not-sufficient condition for DecodeUnverified to accept
// the token — the LIC1-shaped parse check still runs afterwards.
func RegisterFormat(prefix string) error {
	formatMu.Lock()
	defer formatMu.Unlock()
	if slices.Contains(formatPrefixes, prefix) {
		return newError(CodeUnsupportedTokenFormat,
			fmt.Sprintf("format prefix already registered: %s", prefix),
			map[string]any{"prefix": prefix})
	}
	formatPrefixes = append(formatPrefixes, prefix)
	return nil
}

// dispatchFormat returns nil if token's prefix is allowlisted, or
// ErrUnsupportedTokenFormat otherwise. The error carries a clipped prefix
// (up to and including the first dot, or 16 chars) so attackers cannot
// blow up log lines by pasting binary data.
func dispatchFormat(token string) error {
	formatMu.RLock()
	defer formatMu.RUnlock()
	for _, p := range formatPrefixes {
		if strings.HasPrefix(token, p) {
			return nil
		}
	}
	var clipped string
	if idx := strings.IndexByte(token, '.'); idx >= 0 {
		clipped = token[:idx+1]
	} else if len(token) > 16 {
		clipped = token[:16]
	} else {
		clipped = token
	}
	return newError(CodeUnsupportedTokenFormat,
		fmt.Sprintf("unsupported token format prefix: %q", clipped),
		map[string]any{"prefix": clipped})
}

// -----------------------------------------------------------------------
// Header / payload parsing
// -----------------------------------------------------------------------

var headerAllowedAlgs = map[string]struct{}{
	string(AlgEd25519): {},
	string(AlgRSAPSS):  {},
	string(AlgHS256):   {},
}

func parseHeader(b []byte) (LIC1Header, error) {
	var zero LIC1Header
	obj, err := parseJSONObject(b, "header")
	if err != nil {
		return zero, err
	}

	// Strict whitelist. Extra fields are TokenMalformed, distinct from
	// canonical-JSON's UnknownField (that only applies to payload-shaped
	// records with a schema).
	allowed := map[string]bool{"v": true, "typ": true, "alg": true, "kid": true}
	for k := range obj {
		if !allowed[k] {
			return zero, newError(CodeTokenMalformed,
				fmt.Sprintf("header contains unknown field: %s", k),
				map[string]any{"field": k})
		}
	}
	for _, req := range []string{"v", "typ", "alg", "kid"} {
		if _, ok := obj[req]; !ok {
			return zero, newError(CodeTokenMalformed,
				fmt.Sprintf("header missing field: %s", req),
				map[string]any{"field": req})
		}
	}

	// v: must be the number 1.
	vNum, ok := obj["v"].(json.Number)
	if !ok {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("header.v must be 1, got %v", obj["v"]), nil)
	}
	if i, err := vNum.Int64(); err != nil || i != 1 {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("header.v must be 1, got %s", vNum.String()), nil)
	}

	typ, ok := obj["typ"].(string)
	if !ok || typ != "lic" {
		return zero, newError(CodeTokenMalformed,
			fmt.Sprintf("header.typ must be \"lic\", got %v", obj["typ"]), nil)
	}

	algStr, ok := obj["alg"].(string)
	if !ok {
		return zero, newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("header.alg must be a string, got %T", obj["alg"]),
			map[string]any{"alg": obj["alg"]})
	}
	if _, ok := headerAllowedAlgs[algStr]; !ok {
		return zero, newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("no backend registered for alg: %s", algStr),
			map[string]any{"alg": algStr})
	}

	kid, ok := obj["kid"].(string)
	if !ok || kid == "" {
		return zero, newError(CodeTokenMalformed,
			"header.kid must be a non-empty string", nil)
	}

	return LIC1Header{V: 1, Typ: "lic", Alg: KeyAlg(algStr), Kid: kid}, nil
}

func parsePayload(b []byte) (LIC1Payload, error) {
	obj, err := parseJSONObject(b, "payload")
	if err != nil {
		return nil, err
	}
	return LIC1Payload(obj), nil
}

func parseJSONObject(b []byte, label string) (map[string]any, error) {
	if !utf8.Valid(b) {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s is not valid UTF-8", label), nil)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	// Reject trailing garbage after the top-level object.
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s JSON parse failed: %s", label, err.Error()), nil)
	}
	if dec.More() {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s contains trailing data after JSON object", label), nil)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s must decode to a JSON object", label), nil)
	}
	return obj, nil
}
