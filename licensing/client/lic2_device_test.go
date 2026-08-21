package client

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed25519bk "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// A device must be able to validate a token in either registered format.
//
// Regression test for a real defect: Validate called lic.Verify and Peek
// called lic.DecodeUnverified, both LIC1-only by contract. A LIC2 token
// failed with "token format v4.public. is not LIC1; use DecodeEnvelope for
// format-agnostic decoding" — an internal API note surfaced to a device
// user — and because Refresh calls Peek before any network I/O, a LIC2
// device could not even refresh out of the state.
//
// Every other Go LIC2 test drives lic.LIC2Codec directly, bypassing the
// client, which is why the whole suite stayed green while this path was
// broken.

func fixturesDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// licensing/client → licensing → <repo>
	return filepath.Join(wd, "..", "..", "fixtures")
}

func committedToken(t *testing.T, family, id string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixturesDir(t), family, id, "expected_token.txt"))
	if err != nil {
		t.Skipf("fixture %s/%s unavailable: %v", family, id, err)
	}
	return strings.TrimSpace(string(b))
}

func deviceVerifyOptions(t *testing.T) ValidateOptions {
	t.Helper()
	pub, err := os.ReadFile(filepath.Join(fixturesDir(t), "keys", "ed25519", "public.pem"))
	if err != nil {
		t.Skipf("fixture key unavailable: %v", err)
	}
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed25519bk.New()); err != nil {
		t.Fatalf("register backend: %v", err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("fixture-ed25519-1", lic.AlgEd25519); err != nil {
		t.Fatalf("bind kid: %v", err)
	}
	return ValidateOptions{
		Registry: reg,
		Bindings: bindings,
		Keys: map[string]lic.KeyRecord{
			"fixture-ed25519-1": {
				Kid: "fixture-ed25519-1",
				Alg: lic.AlgEd25519,
				Pem: lic.PemKeyMaterial{PublicPem: string(pub)},
			},
		},
		NowSec:      1700000100,
		Fingerprint: strings.Repeat("a", 64),
	}
}

func TestDeviceValidate_AcceptsBothFormats(t *testing.T) {
	cases := []struct {
		name   string
		family string
		id     string
	}{
		{name: "LIC1", family: "tokens", id: "001-ed25519-active"},
		{name: "LIC2", family: "tokens-lic2", id: "001-lic2-active"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token := committedToken(t, tc.family, tc.id)

			res, err := Validate(token, deviceVerifyOptions(t))
			if err != nil {
				t.Fatalf("device could not validate a %s token: %v", tc.name, err)
			}
			if res.LicenseID != "00000000-0000-4000-8000-000000000001" {
				t.Errorf("license_id: got %q", res.LicenseID)
			}
			if res.Alg != lic.AlgEd25519 {
				t.Errorf("alg: got %q", res.Alg)
			}
			if res.Kid != "fixture-ed25519-1" {
				t.Errorf("kid: got %q", res.Kid)
			}
		})
	}
}

// Refresh calls Peek before any network I/O, so a Peek that rejects LIC2
// strands the device permanently.
func TestDevicePeek_AcceptsBothFormats(t *testing.T) {
	for _, tc := range []struct{ name, family, id string }{
		{"LIC1", "tokens", "001-ed25519-active"},
		{"LIC2", "tokens-lic2", "001-lic2-active"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, err := Peek(committedToken(t, tc.family, tc.id))
			if err != nil {
				t.Fatalf("device could not peek a %s token: %v", tc.name, err)
			}
			if res.Exp == 0 {
				t.Error("peek returned no exp claim")
			}
		})
	}
}

// An unregistered prefix must still be rejected on the device.
func TestDeviceValidate_RejectsUnregisteredFormat(t *testing.T) {
	if _, err := Validate("v9.public.abc.def", deviceVerifyOptions(t)); err == nil {
		t.Fatal("expected an unregistered prefix to be rejected")
	}
}
