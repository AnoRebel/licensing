package licensing

import (
	"errors"
	"strings"
	"testing"
)

func TestGenerateLicenseKey_Format(t *testing.T) {
	key := GenerateLicenseKey()
	if !strings.HasPrefix(key, "LIC-") {
		t.Fatalf("missing LIC- prefix: %s", key)
	}
	// Should be 8 groups of 4 chars = LIC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
	parts := strings.Split(key[4:], "-")
	if len(parts) != 8 {
		t.Fatalf("expected 8 groups, got %d: %s", len(parts), key)
	}
	for i, p := range parts {
		if len(p) != 4 {
			t.Fatalf("group %d has %d chars: %s", i, len(p), p)
		}
	}
	// Must match the regex.
	if !licenseKeyRegex.MatchString(key) {
		t.Fatalf("generated key doesn't match regex: %s", key)
	}
}

func TestGenerateLicenseKey_Unique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		k := GenerateLicenseKey()
		if seen[k] {
			t.Fatalf("duplicate key: %s", k)
		}
		seen[k] = true
	}
}

func TestGenerateLicenseKey_NoCrockfordAmbiguous(t *testing.T) {
	for range 50 {
		key := GenerateLicenseKey()
		body := strings.ReplaceAll(key[4:], "-", "")
		for _, c := range body {
			if c == 'I' || c == 'L' || c == 'O' || c == 'U' {
				t.Fatalf("ambiguous char %c in key: %s", c, key)
			}
		}
	}
}

func TestNormalizeLicenseKey_CaseInsensitive(t *testing.T) {
	key := GenerateLicenseKey()
	lower := strings.ToLower(key)
	normalized, ok := NormalizeLicenseKey(lower)
	if !ok {
		t.Fatalf("failed to normalize lowercase key: %s", lower)
	}
	if normalized != key {
		t.Fatalf("normalize(%q) = %q, want %q", lower, normalized, key)
	}
}

func TestNormalizeLicenseKey_Whitespace(t *testing.T) {
	key := GenerateLicenseKey()
	padded := "  " + key + "\t\n"
	normalized, ok := NormalizeLicenseKey(padded)
	if !ok {
		t.Fatalf("failed to normalize padded key")
	}
	if normalized != key {
		t.Fatalf("got %q, want %q", normalized, key)
	}
}

func TestNormalizeLicenseKey_RejectsMalformed(t *testing.T) {
	cases := []string{
		"",
		"not-a-key",
		"LIC-XXXX",      // too few groups
		"LIC-0000-OOOO", // contains O
		"LIC-0000-IIII", // contains I
		"LIC-0000-LLLL", // contains L
		"LIC-0000-UUUU", // contains U
		"abc",
		"LIC-!!!!!!",
	}
	for _, tc := range cases {
		if _, ok := NormalizeLicenseKey(tc); ok {
			t.Errorf("expected rejection for %q", tc)
		}
	}
}

func TestAssertLicenseKey_Valid(t *testing.T) {
	key := GenerateLicenseKey()
	normalized, err := AssertLicenseKey(strings.ToLower(key))
	if err != nil {
		t.Fatalf("AssertLicenseKey: %v", err)
	}
	if normalized != key {
		t.Fatalf("got %q, want %q", normalized, key)
	}
}

func TestAssertLicenseKey_Invalid(t *testing.T) {
	_, err := AssertLicenseKey("bad-key")
	if err == nil {
		t.Fatal("expected error")
	}
	var le *Error
	if !errors.As(err, &le) || le.Code != CodeInvalidLicenseKey {
		t.Fatalf("expected InvalidLicenseKey, got %v", err)
	}
}

func TestBase32Encode_KnownVector(t *testing.T) {
	// All zeros → all '0' characters. 20 bytes → 32 chars.
	data := make([]byte, 20)
	encoded := base32Encode(data)
	if len(encoded) != 32 {
		t.Fatalf("expected 32 chars, got %d", len(encoded))
	}
	expected := strings.Repeat("0", 32)
	if encoded != expected {
		t.Fatalf("got %q, want %q", encoded, expected)
	}
}

func TestBase32Encode_AllOnes(t *testing.T) {
	// All 0xFF → all 'Z' (0x1f = 31 = last symbol).
	data := make([]byte, 20)
	for i := range data {
		data[i] = 0xFF
	}
	encoded := base32Encode(data)
	if len(encoded) != 32 {
		t.Fatalf("expected 32 chars, got %d", len(encoded))
	}
	expected := strings.Repeat("Z", 32)
	if encoded != expected {
		t.Fatalf("got %q, want %q", encoded, expected)
	}
}
