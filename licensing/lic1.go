package licensing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
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
	codec, err := CodecFor(token)
	if err != nil {
		return zero, err
	}
	if codec.Prefix() != LIC1Prefix {
		return zero, newError(CodeUnsupportedTokenFormat,
			fmt.Sprintf("token format %s is not LIC1; use DecodeEnvelope for format-agnostic decoding", codec.Prefix()),
			map[string]any{"prefix": codec.Prefix()})
	}
	return decodeLIC1(token)
}

// DecodeEnvelope performs a shallow parse of a token in any registered
// format, returning the format-agnostic envelope. Use this when the caller
// must accept more than one token format.
func DecodeEnvelope(token string) (DecodedEnvelope, error) {
	codec, err := CodecFor(token)
	if err != nil {
		return DecodedEnvelope{}, err
	}
	return codec.Decode(token)
}

// decodeLIC1 is the LIC1-specific parse. It assumes the prefix has already
// been matched by the router.
func decodeLIC1(token string) (LIC1DecodedParts, error) {
	var zero LIC1DecodedParts
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

// -----------------------------------------------------------------------
// Codec registration
// -----------------------------------------------------------------------

// LIC1Prefix is the ASCII prefix the LIC1 codec owns.
const LIC1Prefix = "LIC1."

// lic1Codec adapts LIC1 to the TokenCodec interface. Decode assumes the
// prefix has already been matched by the router, so a token belonging to
// another format never reaches the LIC1 parser and can never fail with a
// misleading LIC1-shaped ErrTokenMalformed.
type lic1CodecImpl struct{}

// LIC1Codec is the registered LIC1 codec.
var LIC1Codec TokenCodec = lic1CodecImpl{}

// Prefix returns the ASCII prefix the LIC1 codec owns.
func (lic1CodecImpl) Prefix() string { return LIC1Prefix }

// SupportsAlg reports whether LIC1 can carry alg.
func (lic1CodecImpl) SupportsAlg(alg KeyAlg) bool {
	_, ok := headerAllowedAlgs[string(alg)]
	return ok
}

// Decode parses a LIC1 token without verifying its signature. The prefix is
// assumed to have been matched by the router.
func (lic1CodecImpl) Decode(token string) (DecodedEnvelope, error) {
	parts, err := decodeLIC1(token)
	if err != nil {
		return DecodedEnvelope{}, err
	}
	return DecodedEnvelope{
		Header:       EnvelopeHeader{Alg: parts.Header.Alg, Kid: parts.Header.Kid},
		Payload:      parts.Payload,
		SigningInput: parts.SigningInput,
		Signature:    parts.Signature,
	}, nil
}

// Encode builds a signed LIC1 token.
func (lic1CodecImpl) Encode(input CodecEncodeInput) (string, error) {
	return Encode(EncodeOptions{
		Header: LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: input.Alg,
			Kid: input.Kid,
		},
		Payload:    LIC1Payload(input.Payload),
		PrivateKey: input.PrivateKey,
		Backend:    input.Backend,
	})
}

func init() {
	if err := RegisterCodec(LIC1Codec); err != nil {
		panic("licensing: registering the LIC1 codec: " + err.Error())
	}
}

// RegisterFormat is retained for source compatibility with the previous
// prefix-allowlist API, and now always fails.
//
// The old RegisterFormat(prefix) only recorded a permitted prefix; it had no
// parser to route to, so a registered prefix with nothing behind it fell
// through to the LIC1 parser. That is precisely the hazard the codec router
// removes, so accepting such a registration would reintroduce it. Register a
// TokenCodec with RegisterCodec instead.
func RegisterFormat(prefix string) error {
	return newError(CodeUnsupportedTokenFormat,
		fmt.Sprintf("RegisterFormat no longer accepts a bare prefix (%s); register a TokenCodec via RegisterCodec", prefix),
		map[string]any{"prefix": prefix})
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

// parseJSONObject decodes the canonical JSON bytes of a LIC1 header or
// payload into a map[string]any. Unlike a vanilla json.Unmarshal, it
// rejects duplicate keys with CodeCanonicalJSONDuplicateKey BEFORE
// signature verification runs — closing the threat-model gap where the
// stdlib parser silently last-wins on duplicates and a tampered token
// could shadow a claim the issuer signed.
//
// The caller-visible behaviour for any valid (non-duplicate) input is
// byte-identical to the previous json.Unmarshal-based implementation:
// numbers materialise as json.Number, objects as map[string]any, arrays
// as []any, leaves as string/bool/nil. Existing fixtures and round-trip
// tests verify this property byte-for-byte.
func parseJSONObject(b []byte, label string) (map[string]any, error) {
	if !utf8.Valid(b) {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s is not valid UTF-8", label), nil)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := decodeStrictValue(dec, label)
	if err != nil {
		return nil, err
	}
	// Reject trailing garbage after the top-level value.
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

// decodeStrictValue reads one JSON value from dec. Objects are walked
// token-by-token so duplicate keys can be detected before they collapse
// into a Go map (the stdlib silently keeps the last write). Arrays and
// scalars delegate to the equivalent shape json.Decode would produce.
//
// label is the surface used to address errors back to the caller:
// "header" / "payload" today, room for future call sites.
func decodeStrictValue(dec *json.Decoder, label string) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s JSON parse failed: %s", label, err.Error()), nil)
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			return decodeStrictObject(dec, label)
		case '[':
			return decodeStrictArray(dec, label)
		default:
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("%s unexpected delimiter: %s", label, t), nil)
		}
	case string, bool, json.Number, nil:
		return t, nil
	default:
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s unexpected token type: %T", label, tok), nil)
	}
}

func decodeStrictObject(dec *json.Decoder, label string) (map[string]any, error) {
	obj := make(map[string]any)
	for dec.More() {
		// Key.
		ktok, err := dec.Token()
		if err != nil {
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("%s object key parse failed: %s", label, err.Error()), nil)
		}
		key, ok := ktok.(string)
		if !ok {
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("%s object key is not a string: %T", label, ktok), nil)
		}
		if _, exists := obj[key]; exists {
			return nil, newError(CodeCanonicalJSONDuplicateKey,
				fmt.Sprintf("%s contains duplicate key: %s", label, key),
				map[string]any{"key": key, "label": label})
		}
		// Value (recursive).
		val, err := decodeStrictValue(dec, label)
		if err != nil {
			return nil, err
		}
		obj[key] = val
	}
	// Consume the closing '}'.
	if _, err := dec.Token(); err != nil {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s object close parse failed: %s", label, err.Error()), nil)
	}
	return obj, nil
}

func decodeStrictArray(dec *json.Decoder, label string) ([]any, error) {
	arr := make([]any, 0)
	for dec.More() {
		val, err := decodeStrictValue(dec, label)
		if err != nil {
			return nil, err
		}
		arr = append(arr, val)
	}
	// Consume the closing ']'.
	if _, err := dec.Token(); err != nil {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("%s array close parse failed: %s", label, err.Error()), nil)
	}
	return arr, nil
}
