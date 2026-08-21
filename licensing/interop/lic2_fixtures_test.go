package interop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed25519bk "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// LIC2 cross-port vectors.
//
// The committed LIC2 fixtures carry payloads lifted verbatim from the
// ed25519 LIC1 vectors, so the two families differ only in envelope. That is
// what makes the claim-parity guarantee checkable against real bytes rather
// than against a hand-written assertion.
//
// LIC2 is Ed25519-only — PASETO v4 commits to the algorithm in its version
// string — so there is no rs256-pss or hs256 counterpart by construction.

type lic2Vector struct {
	Payload map[string]any `json:"payload"`
	Format  string         `json:"format"`
	Alg     string         `json:"alg"`
	Kid     string         `json:"kid"`
	KeyRef  string         `json:"key_ref"`
	Token   string         `json:"-"`
	Name    string         `json:"-"`
}

func loadLIC2Fixtures(t testing.TB) []lic2Vector {
	t.Helper()
	root := repoRoot(t)
	dir := filepath.Join(root, "fixtures", "tokens-lic2")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read fixtures/tokens-lic2: %v", err)
	}

	var out []lic2Vector
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		vdir := filepath.Join(dir, e.Name())
		inputsBytes, err := os.ReadFile(filepath.Join(vdir, "inputs.json"))
		if err != nil {
			continue
		}
		tokenBytes, err := os.ReadFile(filepath.Join(vdir, "expected_token.txt"))
		if err != nil {
			continue
		}
		var v lic2Vector
		dec := json.NewDecoder(strings.NewReader(string(inputsBytes)))
		dec.UseNumber()
		if err := dec.Decode(&v); err != nil {
			t.Fatalf("decode %s/inputs.json: %v", e.Name(), err)
		}
		v.Token = strings.TrimRight(string(tokenBytes), "\n")
		v.Name = e.Name()
		out = append(out, v)
	}
	if len(out) == 0 {
		t.Fatal("no LIC2 fixtures found — the corpus or its layout changed")
	}
	return out
}

// Go must reproduce the committed LIC2 bytes exactly. Ed25519 signatures are
// deterministic, so this is a true byte comparison rather than a
// verify-only check.
func TestLIC2_GoReproducesCommittedTokens(t *testing.T) {
	for _, v := range loadLIC2Fixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			rec := loadKeyRecord(t, v.KeyRef, v.Kid, lic.KeyAlg(v.Alg))
			backend := ed25519bk.New()
			priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw}, "")
			if err != nil {
				t.Fatalf("import private: %v", err)
			}

			token, err := lic.LIC2Codec.Encode(lic.CodecEncodeInput{
				Alg:        lic.AlgEd25519,
				Kid:        v.Kid,
				Payload:    v.Payload,
				PrivateKey: priv,
				Backend:    backend,
			})
			if err != nil {
				t.Fatalf("go encode: %v", err)
			}
			if token != v.Token {
				t.Errorf("Go-signed LIC2 token != committed expected_token\n  got:  %s\n  want: %s",
					token, v.Token)
			}
		})
	}
}

// Go must verify the committed tokens and surface the recorded claims.
func TestLIC2_GoVerifiesCommittedTokens(t *testing.T) {
	for _, v := range loadLIC2Fixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			rec := loadKeyRecord(t, v.KeyRef, v.Kid, lic.KeyAlg(v.Alg))
			backend := ed25519bk.New()
			pub, err := backend.ImportPublic(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw})
			if err != nil {
				t.Fatalf("import public: %v", err)
			}

			env, err := lic.LIC2Codec.Decode(v.Token)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if env.Header.Kid != v.Kid {
				t.Fatalf("kid: got %q want %q", env.Header.Kid, v.Kid)
			}

			ok, err := backend.Verify(pub, env.SigningInput, env.Signature)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if !ok {
				t.Fatal("committed LIC2 token failed signature verification in Go")
			}

			// Claim parity: every claim recorded in inputs.json must survive
			// the envelope.
			for k, want := range v.Payload {
				got, present := env.Payload[k]
				if !present {
					t.Errorf("claim %q missing from the decoded payload", k)
					continue
				}
				if toJSON(t, got) != toJSON(t, want) {
					t.Errorf("claim %q: got %v want %v", k, got, want)
				}
			}
		})
	}
}

func toJSON(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// TestLIC2RoundTrip_TSSign_GoVerify: every committed LIC2 vector, re-signed
// by the TypeScript implementation, must produce bytes the Go port accepts
// and decodes to the same claims. Ed25519 is deterministic, so this is a
// byte comparison rather than a verify-only check.
func TestLIC2RoundTrip_TSSign_GoVerify(t *testing.T) {
	requireBun(t)
	for _, v := range loadLIC2Fixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			t.Parallel()
			res, err := runBunCLI(t, "sign.ts", map[string]any{
				"alg":     v.Alg,
				"key_ref": v.KeyRef,
				"kid":     v.Kid,
				"header":  map[string]any{},
				"payload": v.Payload,
				"format":  "LIC2",
			})
			if err != nil {
				t.Fatalf("ts sign: %v", err)
			}
			var signed struct {
				Token string `json:"token"`
			}
			if err := json.Unmarshal(res, &signed); err != nil {
				t.Fatalf("decode ts sign result: %v", err)
			}

			if signed.Token != v.Token {
				t.Errorf("TS-signed LIC2 token != committed expected_token\n  got:  %s\n  want: %s",
					signed.Token, v.Token)
			}

			rec := loadKeyRecord(t, v.KeyRef, v.Kid, lic.KeyAlg(v.Alg))
			backend := ed25519bk.New()
			pub, err := backend.ImportPublic(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw})
			if err != nil {
				t.Fatalf("import public: %v", err)
			}
			env, err := lic.LIC2Codec.Decode(signed.Token)
			if err != nil {
				t.Fatalf("go decode of TS-signed LIC2 token: %v", err)
			}
			ok, err := backend.Verify(pub, env.SigningInput, env.Signature)
			if err != nil {
				t.Fatalf("go verify: %v", err)
			}
			if !ok {
				t.Fatal("go rejected a TS-signed LIC2 token")
			}
		})
	}
}

// TestLIC2RoundTrip_GoSign_TSVerify: the same guarantee in the other
// direction — Go signs, TypeScript verifies and reports the claims it saw.
func TestLIC2RoundTrip_GoSign_TSVerify(t *testing.T) {
	requireBun(t)
	for _, v := range loadLIC2Fixtures(t) {
		t.Run(v.Name, func(t *testing.T) {
			t.Parallel()
			rec := loadKeyRecord(t, v.KeyRef, v.Kid, lic.KeyAlg(v.Alg))
			backend := ed25519bk.New()
			priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: rec.Pem, Raw: rec.Raw}, "")
			if err != nil {
				t.Fatalf("import private: %v", err)
			}
			token, err := lic.LIC2Codec.Encode(lic.CodecEncodeInput{
				Alg:        lic.AlgEd25519,
				Kid:        v.Kid,
				Payload:    v.Payload,
				PrivateKey: priv,
				Backend:    backend,
			})
			if err != nil {
				t.Fatalf("go sign: %v", err)
			}

			res, err := runBunCLI(t, "verify.ts", map[string]any{
				"token":   token,
				"alg":     v.Alg,
				"key_ref": v.KeyRef,
				"kid":     v.Kid,
			})
			if err != nil {
				t.Fatalf("ts verify rejected a Go-signed LIC2 token: %v", err)
			}

			var verified struct {
				Payload map[string]any `json:"payload"`
			}
			if err := json.Unmarshal(res, &verified); err != nil {
				t.Fatalf("decode ts verify result: %v", err)
			}
			// Claims must survive the crossing unchanged.
			for k, want := range v.Payload {
				got, present := verified.Payload[k]
				if !present {
					t.Errorf("claim %q missing after TS verify", k)
					continue
				}
				if toJSON(t, got) != toJSON(t, want) {
					t.Errorf("claim %q: TS saw %v, fixture records %v", k, got, want)
				}
			}
		})
	}
}
