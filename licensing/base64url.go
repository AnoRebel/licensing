package licensing

import (
	"encoding/base64"
	"strings"
)

// Base64urlEncode returns the RFC 4648 §5 base64url encoding of b, without
// `=` padding. Mirrors the TypeScript encode() in base64url.ts.
func Base64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// Base64urlDecode decodes a padding-free base64url string. Input containing
// `=` or non-alphabet characters is rejected with ErrTokenMalformed — the
// LIC1 wire format never emits padding, and a spurious `=` is almost
// certainly a sign of a tampered token or a wrong alphabet.
func Base64urlDecode(s string) ([]byte, error) {
	if strings.ContainsRune(s, '=') {
		return nil, newError(CodeTokenMalformed,
			"base64url segment contains padding", nil)
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'A' || c > 'Z') &&
			(c < 'a' || c > 'z') &&
			(c < '0' || c > '9') &&
			c != '-' && c != '_' {
			return nil, newError(CodeTokenMalformed,
				"base64url segment contains invalid characters", nil)
		}
	}
	return base64.RawURLEncoding.DecodeString(s)
}
