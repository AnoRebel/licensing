package licensing

// License key generation, normalization, and validation — Go port of
// typescript/packages/core/src/license-key.ts.
//
// Format: LIC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// 8 groups of 4 Crockford Base32 characters = 32 chars × 5 bits = 160 bits.
//
// Crockford alphabet: 0-9 A-H J K M N P-T V-Z (32 symbols, no I/L/O/U).
// Normalization is case-insensitive: trim + uppercase. Lowercase i/l/o/u
// are rejected (not silently rewritten), which is stricter than canonical
// Crockford but guarantees deterministic round-trip.

import (
	"crypto/rand"
	"regexp"
	"strings"
)

// crockfordAlphabet is the Crockford Base32 encoding table.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// licenseKeyRegex matches a well-formed license key:
// LIC- + ≥5 groups of 4 Crockford chars (i.e. 8 groups for 160-bit keys,
// but the regex allows 5+ for forward compatibility).
var licenseKeyRegex = regexp.MustCompile(
	`^LIC-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4,}$`,
)

// GenerateLicenseKey returns a fresh license key with 160 bits of entropy.
func GenerateLicenseKey() string {
	// 160 bits = 20 bytes.
	var buf [20]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic("licensing: rand.Read failed: " + err.Error())
	}
	encoded := base32Encode(buf[:])
	return "LIC-" + formatGroups(encoded, 4)
}

// NormalizeLicenseKey trims whitespace, uppercases, and validates a
// user-supplied key. Returns ("", false) if the normalized form doesn't
// match the required shape.
func NormalizeLicenseKey(input string) (string, bool) {
	trimmed := strings.ToUpper(strings.TrimSpace(input))
	if !licenseKeyRegex.MatchString(trimmed) {
		return "", false
	}
	return trimmed, true
}

// AssertLicenseKey validates and returns the normalized form.
// Returns an InvalidLicenseKey error if malformed.
func AssertLicenseKey(input string) (string, error) {
	normalized, ok := NormalizeLicenseKey(input)
	if !ok {
		return "", newError(CodeInvalidLicenseKey,
			"license key format is invalid or unrecognized", nil)
	}
	return normalized, nil
}

// ---------- internals ----------

// base32Encode encodes bytes to Crockford Base32. Output length is
// ceil(len(bytes) * 8 / 5) — for 20 bytes, that's 32 chars.
func base32Encode(data []byte) string {
	var out strings.Builder
	out.Grow((len(data)*8 + 4) / 5)
	var buf, bits uint
	for _, b := range data {
		buf = (buf << 8) | uint(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			out.WriteByte(crockfordAlphabet[(buf>>bits)&0x1f])
		}
	}
	if bits > 0 {
		out.WriteByte(crockfordAlphabet[(buf<<(5-bits))&0x1f])
	}
	return out.String()
}

// formatGroups splits s into groups of size characters joined by "-".
func formatGroups(s string, size int) string {
	var b strings.Builder
	for i := 0; i < len(s); i += size {
		if i > 0 {
			b.WriteByte('-')
		}
		b.WriteString(s[i:min(i+size, len(s))])
	}
	return b.String()
}
