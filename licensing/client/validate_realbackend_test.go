package client

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
)

// TestValidate_WithRealEd25519Backend exercises the full client.Validate
// pipeline against a real Ed25519 signature — no fakeBackend. This is the
// end-to-end sanity check that our LIC1 tokens sign and verify with the
// production backend.
func TestValidate_WithRealEd25519Backend(t *testing.T) {
	backend := ed.New()

	pemMat, _, err := backend.Generate("")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	priv, err := backend.ImportPrivate(lic.KeyMaterial{Pem: pemMat}, "")
	if err != nil {
		t.Fatalf("import priv: %v", err)
	}

	now := int64(1700000000)
	tok, err := lic.Encode(lic.EncodeOptions{
		Header: lic.LIC1Header{
			V:   1,
			Typ: "lic",
			Alg: lic.AlgEd25519,
			Kid: "real-kid",
		},
		Payload:    basePayload(now),
		PrivateKey: priv,
		Backend:    backend,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(backend); err != nil {
		t.Fatal(err)
	}
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind("real-kid", lic.AlgEd25519); err != nil {
		t.Fatal(err)
	}
	keys := map[string]lic.KeyRecord{
		"real-kid": {
			Kid: "real-kid",
			Alg: lic.AlgEd25519,
			Pem: lic.PemKeyMaterial{PublicPem: pemMat.PublicPem},
		},
	}

	res, err := Validate(tok, ValidateOptions{
		Registry: reg, Bindings: bindings, Keys: keys,
		Fingerprint: "fp-1", NowSec: now,
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if res.LicenseID != "lic-1" {
		t.Fatalf("license id drift: %s", res.LicenseID)
	}
}
