package client

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMemoryTokenStore_ReadWriteClear(t *testing.T) {
	s := NewMemoryTokenStore()
	state, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if state.Token != "" {
		t.Fatalf("expected empty, got %q", state.Token)
	}

	gs := int64(1234)
	if err := s.Write(StoredTokenState{Token: "abc", GraceStartSec: &gs}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Read()
	if got.Token != "abc" {
		t.Fatalf("token drift: %q", got.Token)
	}
	if got.GraceStartSec == nil || *got.GraceStartSec != 1234 {
		t.Fatalf("grace drift: %v", got.GraceStartSec)
	}

	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Read()
	if got.Token != "" || got.GraceStartSec != nil {
		t.Fatalf("clear failed: %+v", got)
	}
}

func TestFileTokenStore_AtomicRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "token.json")
	s := NewFileTokenStore(path)

	// Missing file -> empty state, no error.
	got, err := s.Read()
	if err != nil {
		t.Fatalf("read missing: %v", err)
	}
	if got.Token != "" {
		t.Fatalf("expected empty, got %+v", got)
	}

	gs := int64(42)
	if err := s.Write(StoredTokenState{Token: "tok", GraceStartSec: &gs}); err != nil {
		t.Fatal(err)
	}

	// File permissions check.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("expected mode 0600, got %v", info.Mode().Perm())
	}

	got, err = s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != "tok" {
		t.Fatalf("drift: %+v", got)
	}

	// Clear removes file.
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected file removed, got err=%v", err)
	}

	// Clear on missing is fine.
	if err := s.Clear(); err != nil {
		t.Fatalf("clear on missing: %v", err)
	}
}

func TestFileTokenStore_CorruptedFileSurfacesError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token.json")
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewFileTokenStore(path)
	got, err := s.Read()
	if err == nil {
		t.Fatal("corrupted file should surface an error")
	}
	if got.Token != "" {
		t.Fatalf("expected empty state returned alongside error, got %+v", got)
	}
}
