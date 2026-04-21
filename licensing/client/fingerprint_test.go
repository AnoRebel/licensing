package client

import (
	"strings"
	"testing"
)

func TestFingerprintFromSources_Deterministic(t *testing.T) {
	sources := []string{"os:linux:amd64", "salt:app-v1", "machine:abc123"}
	h1, err := FingerprintFromSources(sources)
	if err != nil {
		t.Fatal(err)
	}
	// Different order, same result.
	reordered := []string{"salt:app-v1", "machine:abc123", "os:linux:amd64"}
	h2, err := FingerprintFromSources(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("order should not affect hash: %s vs %s", h1, h2)
	}
	if len(h1) != 64 {
		t.Fatalf("expected 64-char hex, got %d", len(h1))
	}
}

func TestFingerprintFromSources_RejectsEmpty(t *testing.T) {
	if _, err := FingerprintFromSources(nil); err == nil {
		t.Fatal("expected error for empty source list")
	}
	if _, err := FingerprintFromSources([]string{""}); err == nil {
		t.Fatal("expected error for empty source string")
	}
	if _, err := FingerprintFromSources([]string{"a\nb"}); err == nil {
		t.Fatal("expected error for newline in source")
	}
}

func TestCollectFingerprint_RejectsAllEmpty(t *testing.T) {
	srcs := []FingerprintSource{
		emptySource{},
		emptySource{},
	}
	if _, err := CollectFingerprint(srcs); err == nil {
		t.Fatal("expected error when all sources return empty")
	}
}

func TestDefaultFingerprintSources_RequiresAppSalt(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for empty appSalt")
		}
	}()
	DefaultFingerprintSources("")
}

func TestDefaultFingerprintSources_ProducesHash(t *testing.T) {
	srcs := DefaultFingerprintSources("test-salt-v1")
	h, err := CollectFingerprint(srcs)
	if err != nil {
		t.Fatalf("CollectFingerprint: %v", err)
	}
	if len(h) != 64 {
		t.Fatalf("expected 64-char hex, got %d: %s", len(h), h)
	}
	// Deterministic within a process.
	h2, err := CollectFingerprint(srcs)
	if err != nil {
		t.Fatal(err)
	}
	if h != h2 {
		t.Fatalf("non-deterministic: %s vs %s", h, h2)
	}
}

func TestSaltSource_Prefix(t *testing.T) {
	s := saltSource{salt: "foo"}
	v, err := s.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(v, "salt:") {
		t.Fatalf("expected salt: prefix, got %q", v)
	}
}

type emptySource struct{}

func (emptySource) Name() string             { return "empty" }
func (emptySource) Collect() (string, error) { return "", nil }
