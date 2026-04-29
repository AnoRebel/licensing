package trials_test

import (
	"strings"
	"testing"

	"github.com/AnoRebel/licensing/licensing/trials"
)

const rock = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 32 chars

func TestHashFingerprint_Deterministic(t *testing.T) {
	a, err := trials.HashFingerprint(rock, "fp:User:u1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := trials.HashFingerprint(rock, "fp:User:u1")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("hash should be deterministic: %s vs %s", a, b)
	}
	if len(a) != 64 || strings.ToLower(a) != a {
		t.Fatalf("expected 64-char lowercase hex, got %q", a)
	}
}

func TestHashFingerprint_PepperMatters(t *testing.T) {
	a, _ := trials.HashFingerprint(rock, "fp:User:u1")
	b, _ := trials.HashFingerprint(strings.Repeat("b", 32), "fp:User:u1")
	if a == b {
		t.Fatal("different pepper must produce different hash")
	}
}

func TestHashFingerprint_RejectsShortPepper(t *testing.T) {
	_, err := trials.HashFingerprint("short", "fp")
	if err == nil {
		t.Fatal("expected length error for short pepper")
	}
}

func TestPepperStore_HashConsistent(t *testing.T) {
	s, err := trials.NewPepperStore(rock)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.Hash("fp:User:u1")
	b, _ := trials.HashFingerprint(rock, "fp:User:u1")
	if a != b {
		t.Fatalf("store hash mismatch: %s vs %s", a, b)
	}
}

func TestNewPepperStore_RejectsShort(t *testing.T) {
	_, err := trials.NewPepperStore("short")
	if err == nil {
		t.Fatal("expected length error")
	}
}
