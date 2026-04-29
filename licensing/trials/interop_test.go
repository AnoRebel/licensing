package trials_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/AnoRebel/licensing/licensing/trials"
)

type canonicalFixture struct {
	Pepper           string `json:"pepper"`
	FingerprintInput string `json:"fingerprint_input"`
	FingerprintHash  string `json:"fingerprint_hash"`
}

func loadCanonical(t *testing.T) canonicalFixture {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..")
	path := filepath.Join(root, "fixtures", "trials", "canonical.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx canonicalFixture
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return fx
}

// TestCrossPortHashParity asserts the Go hash matches the canonical fixture
// produced by both ports. The TS side has the same test against the same
// fixture; if either port drifts, the cross-language interop suite catches it.
func TestCrossPortHashParity(t *testing.T) {
	fx := loadCanonical(t)
	got, err := trials.HashFingerprint(fx.Pepper, fx.FingerprintInput)
	if err != nil {
		t.Fatal(err)
	}
	if got != fx.FingerprintHash {
		t.Fatalf("hash mismatch:\n  got:  %s\n  want: %s", got, fx.FingerprintHash)
	}
}
