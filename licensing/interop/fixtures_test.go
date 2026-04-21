package interop

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed25519bk "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	hmacbk "github.com/AnoRebel/licensing/licensing/crypto/hmac"
	rsabk "github.com/AnoRebel/licensing/licensing/crypto/rsa"
)

// fixtureVector describes one on-disk fixture token: its inputs.json and the
// expected LIC1 token emitted by the fixture-generator. The interop tests
// re-sign the inputs with the TS and Go implementations and assert every
// path lands on the same verifiable LIC1 string.
type fixtureVector struct {
	Name    string
	Inputs  fixtureInputs
	Token   string // expected LIC1 token as a utf-8 string, trailing newline stripped
	TokenID string // e.g. "001-ed25519-active" — stable for test names
}

// fixtureInputs mirrors tools/fixture-generator's ValidInputs shape.
// Declared independently here so the interop tests never import the
// generator — keeping the harness dependency-free.
type fixtureInputs struct {
	Header  map[string]any `json:"header"`
	Payload map[string]any `json:"payload"`
	Alg     string         `json:"alg"`
	Kid     string         `json:"kid"`
	KeyRef  string         `json:"key_ref"`
}

// loadFixtures enumerates fixtures/tokens/NNN-* that have both inputs.json
// and expected_token.txt. The `tampers.json`-bearing directories still
// appear in iteration but we only care about their happy-path inputs.
func loadFixtures(t testing.TB) []fixtureVector {
	t.Helper()
	root := repoRoot(t)
	tokensDir := filepath.Join(root, "fixtures", "tokens")
	entries, err := os.ReadDir(tokensDir)
	if err != nil {
		t.Fatalf("read fixtures/tokens: %v", err)
	}

	var out []fixtureVector
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		dir := filepath.Join(tokensDir, name)

		inputsPath := filepath.Join(dir, "inputs.json")
		tokenPath := filepath.Join(dir, "expected_token.txt")
		if _, err := os.Stat(inputsPath); err != nil {
			continue
		}
		if _, err := os.Stat(tokenPath); err != nil {
			continue
		}
		inputsBytes, err := os.ReadFile(inputsPath)
		if err != nil {
			t.Fatalf("read %s: %v", inputsPath, err)
		}
		var fi fixtureInputs
		if err := json.Unmarshal(inputsBytes, &fi); err != nil {
			t.Fatalf("decode %s: %v", inputsPath, err)
		}
		tokenBytes, err := os.ReadFile(tokenPath)
		if err != nil {
			t.Fatalf("read %s: %v", tokenPath, err)
		}
		out = append(out, fixtureVector{
			Name:    name,
			TokenID: name,
			Inputs:  fi,
			Token:   strings.TrimRight(string(tokenBytes), "\r\n"),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) == 0 {
		t.Fatalf("no fixtures found under %s", tokensDir)
	}
	return out
}

// loadKeyRecord hydrates a Go lic.KeyRecord from fixtures/keys/<ref>. Mirrors
// tools/interop/src/keys.ts so both sides see identical material.
func loadKeyRecord(t testing.TB, ref, kid string, alg lic.KeyAlg) lic.KeyRecord {
	t.Helper()
	// Whitelist ref so a malformed fixture inputs.json can't pivot the
	// loader outside fixtures/keys/ via `../`. Matches tools/interop/src/keys.ts.
	switch ref {
	case "ed25519", "rsa", "hmac":
	default:
		t.Fatalf("invalid key_ref: %q", ref)
	}
	root := repoRoot(t)
	base := filepath.Join(root, "fixtures", "keys", ref)
	rec := lic.KeyRecord{Kid: kid, Alg: alg}
	if alg == lic.AlgHS256 {
		hexStr, err := os.ReadFile(filepath.Join(base, "secret.hex"))
		if err != nil {
			t.Fatalf("read hmac secret: %v", err)
		}
		raw, err := hex.DecodeString(strings.TrimSpace(string(hexStr)))
		if err != nil {
			t.Fatalf("decode hmac secret: %v", err)
		}
		rec.Raw = lic.RawKeyMaterial{PrivateRaw: raw, PublicRaw: raw}
		return rec
	}
	privPem, err := os.ReadFile(filepath.Join(base, "private.pem"))
	if err != nil {
		t.Fatalf("read %s/private.pem: %v", ref, err)
	}
	pubPem, err := os.ReadFile(filepath.Join(base, "public.pem"))
	if err != nil {
		t.Fatalf("read %s/public.pem: %v", ref, err)
	}
	rec.Pem = lic.PemKeyMaterial{PrivatePem: string(privPem), PublicPem: string(pubPem)}
	return rec
}

// verifyRegistry builds a (registry, bindings, keys-map) triple preloaded
// with the single backend needed for the given alg. Callers use this to run
// lic.Verify / client.Validate against fixture keys.
func verifyRegistry(t testing.TB, rec lic.KeyRecord) (*lic.AlgorithmRegistry, *lic.KeyAlgBindings, map[string]lic.KeyRecord) {
	t.Helper()
	reg := lic.NewAlgorithmRegistry()
	switch rec.Alg {
	case lic.AlgEd25519:
		if err := reg.Register(ed25519bk.New()); err != nil {
			t.Fatalf("register ed25519: %v", err)
		}
	case lic.AlgRSAPSS:
		if err := reg.Register(rsabk.New()); err != nil {
			t.Fatalf("register rsa: %v", err)
		}
	case lic.AlgHS256:
		if err := reg.Register(hmacbk.New()); err != nil {
			t.Fatalf("register hmac: %v", err)
		}
	default:
		t.Fatalf("unsupported alg %q", rec.Alg)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind(rec.Kid, rec.Alg); err != nil {
		t.Fatalf("bind: %v", err)
	}
	keys := map[string]lic.KeyRecord{rec.Kid: rec}
	return reg, bindings, keys
}
