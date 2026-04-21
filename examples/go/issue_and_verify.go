//go:build ignore
// +build ignore

// Issuer example: bootstrap → license → usage → token → verify.
//
// Shows the full service-layer flow without any HTTP surface. Uses
// in-memory storage so it runs in isolation.
//
// Run: cd golang && go run ./examples/issue_and_verify.go

package main

import (
	"fmt"
	"log"
	"strings"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

func main() {
	clk := lic.SystemClock{}
	store := memory.New(memory.Options{})

	registry := lic.NewAlgorithmRegistry()
	if err := registry.Register(ed25519.New()); err != nil {
		log.Fatal(err)
	}

	// 1. Bootstrap keys (global scope — scope_id defaults to null).
	root, err := lic.GenerateRootKey(store, clk, registry, lic.GenerateRootKeyInput{
		Alg:        lic.AlgEd25519,
		Passphrase: "root-pw",
	}, lic.KeyIssueOptions{})
	if err != nil {
		log.Fatalf("GenerateRootKey: %v", err)
	}

	signing, err := lic.IssueInitialSigningKey(store, clk, registry, lic.IssueInitialSigningKeyInput{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "root-pw",
		SigningPassphrase: "sign-pw",
	}, lic.KeyIssueOptions{})
	if err != nil {
		log.Fatalf("IssueInitialSigningKey: %v", err)
	}
	fmt.Println("Bootstrapped signing key:", signing.Kid)

	// 2. Create a license.
	license, err := lic.CreateLicense(store, clk, lic.CreateLicenseInput{
		LicensableType: "User",
		LicensableID:   "user-42",
		Status:         lic.LicenseStatusActive,
		MaxUsages:      3,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		log.Fatalf("CreateLicense: %v", err)
	}
	fmt.Println("License created:", license.ID, "status:", license.Status)

	// 3. Register a device — claims seat 1/3.
	fingerprint := strings.Repeat("a", 64)
	usage, err := lic.RegisterUsage(store, clk, lic.RegisterUsageInput{
		LicenseID:   license.ID,
		Fingerprint: fingerprint,
	}, lic.RegisterUsageOptions{})
	if err != nil {
		log.Fatalf("RegisterUsage: %v", err)
	}
	fmt.Println("Usage registered:", usage.Usage.ID)

	// 4. Issue a LIC1 token, TTL 1 hour.
	result, err := lic.IssueToken(store, clk, registry, lic.IssueTokenInput{
		License:           license,
		Usage:             usage.Usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: "sign-pw",
	})
	if err != nil {
		log.Fatalf("IssueToken: %v", err)
	}
	fmt.Println("Token issued:", result.Token[:60], "…")

	// 5. Verify independently — as a client holding only the public key would.
	storedKey, err := store.GetKeyByKid(signing.Kid)
	if err != nil || storedKey == nil {
		log.Fatalf("GetKeyByKid: %v", err)
	}

	verifyRegistry := lic.NewAlgorithmRegistry()
	_ = verifyRegistry.Register(ed25519.New())

	bindings := lic.NewKeyAlgBindings()
	_ = bindings.Bind(signing.Kid, lic.AlgEd25519)

	verified, err := lic.Verify(result.Token, lic.VerifyOptions{
		Registry: verifyRegistry,
		Bindings: bindings,
		Keys: map[string]lic.KeyRecord{
			signing.Kid: {
				Kid: storedKey.Kid,
				Alg: storedKey.Alg,
				Pem: lic.PemKeyMaterial{PublicPem: storedKey.PublicPem},
			},
		},
	})
	if err != nil {
		log.Fatalf("Verify: %v", err)
	}

	fmt.Printf("Verified payload: license_id=%v exp=%v\n",
		verified.Payload["license_id"], verified.Payload["exp"])
}
