package licensing

import "fmt"

// VerifyOptions carries the dependencies Verify needs. All three are
// typically constructed once at process start and reused.
type VerifyOptions struct {
	Registry *AlgorithmRegistry
	Bindings *KeyAlgBindings
	Keys     map[string]KeyRecord // indexed by kid
}

// Verify parses a LIC1 token and verifies its signature. On success it
// returns the decoded parts; on failure it returns an Error whose Code
// identifies the problem — TokenMalformed, UnsupportedAlgorithm,
// UnknownKid, AlgorithmMismatch, TokenSignatureInvalid, and so on.
//
// Ordering is load-bearing for security:
//  1. Format dispatch   (UnsupportedTokenFormat)
//  2. Shape + header    (TokenMalformed / UnsupportedAlgorithm)
//  3. Alg-confusion     (ErrAlgorithmMismatch / ErrUnknownKid) — BEFORE crypto
//  4. Backend + verify  (TokenSignatureInvalid)
//
// Step 3 means a token whose header alg disagrees with the pre-bound
// (kid, alg) pair never reaches a backend's Verify call.
func Verify(token string, opts VerifyOptions) (LIC1DecodedParts, error) {
	var zero LIC1DecodedParts
	// Verify's contract returns LIC1-shaped parts, so it serves LIC1 tokens
	// only; DecodeUnverified rejects any other registered format with a
	// clear error. Callers accepting more than one format use
	// VerifyEnvelope.
	parts, err := DecodeUnverified(token)
	if err != nil {
		return zero, err
	}
	if _, err := VerifyEnvelope(token, opts); err != nil {
		return zero, err
	}
	return parts, nil
}

// VerifyEnvelope parses and verifies a token in any registered format,
// returning the format-agnostic envelope.
//
// The signing input comes from the codec that owns the token's prefix, so a
// signature valid only under a different format's construction is rejected.
func VerifyEnvelope(token string, opts VerifyOptions) (DecodedEnvelope, error) {
	var zero DecodedEnvelope
	parts, err := DecodeEnvelope(token)
	if err != nil {
		return zero, err
	}

	// Alg-confusion guard.
	if _, err := opts.Bindings.Expect(parts.Header.Kid, parts.Header.Alg); err != nil {
		return zero, err
	}

	backend, err := opts.Registry.Get(parts.Header.Alg)
	if err != nil {
		return zero, err
	}

	record, ok := opts.Keys[parts.Header.Kid]
	if !ok {
		return zero, newError(CodeUnknownKid,
			fmt.Sprintf("unknown kid: %s", parts.Header.Kid),
			map[string]any{"kid": parts.Header.Kid})
	}
	if record.Alg != parts.Header.Alg {
		return zero, newError(CodeAlgorithmMismatch,
			fmt.Sprintf("alg mismatch for kid: expected %s, got %s",
				record.Alg, parts.Header.Alg),
			map[string]any{
				"expected": string(record.Alg),
				"actual":   string(parts.Header.Alg),
			})
	}

	pub, err := backend.ImportPublic(KeyMaterial{Pem: record.Pem, Raw: record.Raw})
	if err != nil {
		return zero, err
	}
	ok2, err := backend.Verify(pub, parts.SigningInput, parts.Signature)
	if err != nil {
		return zero, err
	}
	if !ok2 {
		return zero, newError(CodeTokenSignatureInvalid,
			"token signature verification failed", nil)
	}
	return parts, nil
}
