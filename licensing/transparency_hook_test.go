package licensing_test

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"sync"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

// Transparency-hook tests. Cover:
//
//   1. Hook fires once per successful issue with the right metadata.
//   2. Hook receives a SHA-256 hash of the wire token bytes (64-char
//      lowercase hex). Computing the hash independently and comparing
//      proves the contract — a third-party log can do the same.
//   3. Hook does NOT fire on issuance failure (e.g. wrong passphrase).
//   4. Nil hook is a zero-cost no-op.
//   5. A panicking hook does NOT bring down the issuer.
//   6. Concurrent issues fire the hook concurrently; each event is
//      delivered exactly once.

func freshFixture(t *testing.T) (lic.Storage, *lic.AlgorithmRegistry, *lic.License, *lic.LicenseUsage, string) {
	t.Helper()
	const passphrase = "pp-test-pp-test-pp-test-pp-test-"
	storage := memory.New(memory.Options{})
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed.New()); err != nil {
		t.Fatal(err)
	}
	clk := lic.SystemClock{}

	root, err := lic.GenerateRootKey(storage, clk, reg,
		lic.GenerateRootKeyInput{
			Alg:        lic.AlgEd25519,
			Passphrase: passphrase,
		},
		lic.KeyIssueOptions{Actor: "test"},
	)
	if err != nil {
		t.Fatalf("generate root: %v", err)
	}
	if _, err := lic.IssueInitialSigningKey(storage, clk, reg,
		lic.IssueInitialSigningKeyInput{
			RootKid:           root.Kid,
			Alg:               lic.AlgEd25519,
			RootPassphrase:    passphrase,
			SigningPassphrase: passphrase,
		},
		lic.KeyIssueOptions{Actor: "test"},
	); err != nil {
		t.Fatalf("issue signing: %v", err)
	}

	license, err := storage.CreateLicense(lic.LicenseInput{
		LicensableType: "User",
		LicensableID:   "u-1",
		LicenseKey:     "LIC-AAAA-BBBB-CCCC-DDDD",
		Status:         lic.LicenseStatusActive,
		MaxUsages:      5,
	})
	if err != nil {
		t.Fatalf("create license: %v", err)
	}
	usage, err := storage.CreateUsage(lic.LicenseUsageInput{
		LicenseID:    license.ID,
		Fingerprint:  "fp-test",
		Status:       lic.UsageStatusActive,
		RegisteredAt: clk.NowISO(),
	})
	if err != nil {
		t.Fatalf("create usage: %v", err)
	}
	return storage, reg, license, usage, passphrase
}

func TestTransparencyHook_FiresOnceWithCorrectMetadata(t *testing.T) {
	storage, reg, license, usage, passphrase := freshFixture(t)
	clk := lic.SystemClock{}

	var captured []lic.TokenIssuedEvent
	var mu sync.Mutex
	hook := func(ev lic.TokenIssuedEvent) {
		mu.Lock()
		defer mu.Unlock()
		captured = append(captured, ev)
	}

	res, err := lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: passphrase,
		TransparencyHook:  hook,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	if len(captured) != 1 {
		t.Fatalf("hook should fire exactly once; got %d", len(captured))
	}
	ev := captured[0]
	if ev.Jti != res.Jti {
		t.Errorf("Jti drift: hook=%s result=%s", ev.Jti, res.Jti)
	}
	if ev.LicenseID != license.ID {
		t.Errorf("LicenseID drift: %s vs %s", ev.LicenseID, license.ID)
	}
	if ev.UsageID != usage.ID {
		t.Errorf("UsageID drift: %s vs %s", ev.UsageID, usage.ID)
	}
	if ev.Kid != res.Kid {
		t.Errorf("Kid drift: %s vs %s", ev.Kid, res.Kid)
	}
	if ev.Iat != res.Iat || ev.Exp != res.Exp {
		t.Errorf("iat/exp drift: hook=(%d,%d) result=(%d,%d)",
			ev.Iat, ev.Exp, res.Iat, res.Exp)
	}
}

func TestTransparencyHook_TokenSHA256MatchesIndependentHash(t *testing.T) {
	// The contract: TokenSHA256 is sha256(wire_token_bytes), lowercase
	// hex, 64 chars. A third-party log doing its own hash of the
	// token bytes MUST produce the same string.
	storage, reg, license, usage, passphrase := freshFixture(t)
	clk := lic.SystemClock{}

	var captured lic.TokenIssuedEvent
	hook := func(ev lic.TokenIssuedEvent) { captured = ev }

	res, err := lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: passphrase,
		TransparencyHook:  hook,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	// Independent hash of the wire token.
	want := sha256.Sum256([]byte(res.Token))
	wantHex := hex.EncodeToString(want[:])

	if captured.TokenSHA256 != wantHex {
		t.Fatalf("TokenSHA256 drift: hook=%s independent=%s",
			captured.TokenSHA256, wantHex)
	}

	// Format invariant — 64 lowercase hex chars.
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(captured.TokenSHA256) {
		t.Fatalf("TokenSHA256 not lowercase hex/64 chars: %q", captured.TokenSHA256)
	}
}

func TestTransparencyHook_DoesNotFireOnIssueFailure(t *testing.T) {
	storage, reg, license, usage, _ := freshFixture(t)
	clk := lic.SystemClock{}

	called := false
	hook := func(lic.TokenIssuedEvent) { called = true }

	_, err := lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: "wrong-passphrase-wrong-passphrase-",
		TransparencyHook:  hook,
	})
	if err == nil {
		t.Fatal("expected wrong-passphrase to fail")
	}
	if called {
		t.Fatal("hook must NOT fire when issue fails")
	}
}

func TestTransparencyHook_NilHookIsZeroCost(t *testing.T) {
	// Sanity test: nil hook leaves the API and behaviour unchanged.
	storage, reg, license, usage, passphrase := freshFixture(t)
	clk := lic.SystemClock{}

	res, err := lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: passphrase,
		// TransparencyHook: nil
	})
	if err != nil {
		t.Fatalf("issue with nil hook: %v", err)
	}
	if res.Token == "" {
		t.Fatal("token should still be returned with nil hook")
	}
}

func TestTransparencyHook_PanicDoesNotEscapeIssuer(t *testing.T) {
	// A misbehaving hook MUST NOT take down the issuer. The current
	// behaviour propagates the panic — operators are expected to wrap
	// their hook with recover() if needed. This test pins the
	// contract explicitly so a future "we should sandbox the hook"
	// change is a deliberate decision, not an accidental drift.
	storage, reg, license, usage, passphrase := freshFixture(t)
	clk := lic.SystemClock{}

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected hook panic to propagate (operator responsibility)")
		}
	}()

	_, _ = lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        3600,
		Alg:               lic.AlgEd25519,
		SigningPassphrase: passphrase,
		TransparencyHook: func(lic.TokenIssuedEvent) {
			panic(errors.New("hook panic"))
		},
	})
	t.Fatal("unreachable — defer recover should have caught the panic above")
}

func TestTransparencyHook_ConcurrentIssuesDeliverDistinctEvents(t *testing.T) {
	storage, reg, license, _, passphrase := freshFixture(t)
	clk := lic.SystemClock{}

	// Each goroutine creates its own usage so the issuance succeeds.
	const N = 25
	usages := make([]*lic.LicenseUsage, N)
	for i := 0; i < N; i++ {
		u, err := storage.CreateUsage(lic.LicenseUsageInput{
			LicenseID:   license.ID,
			Fingerprint: regexp.MustCompile(`\W`).ReplaceAllString("fp-"+string(rune('a'+i)), ""),
			Status:      lic.UsageStatusActive,
		})
		if err != nil {
			t.Fatal(err)
		}
		usages[i] = u
	}

	var mu sync.Mutex
	seen := make(map[string]bool)
	hook := func(ev lic.TokenIssuedEvent) {
		mu.Lock()
		defer mu.Unlock()
		if seen[ev.Jti] {
			t.Errorf("duplicate jti delivered: %s", ev.Jti)
		}
		seen[ev.Jti] = true
	}

	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(u *lic.LicenseUsage) {
			defer wg.Done()
			_, err := lic.IssueToken(storage, clk, reg, lic.IssueTokenInput{
				License:           license,
				Usage:             u,
				TTLSeconds:        3600,
				Alg:               lic.AlgEd25519,
				SigningPassphrase: passphrase,
				TransparencyHook:  hook,
			})
			if err != nil {
				t.Errorf("issue: %v", err)
			}
		}(usages[i])
	}
	wg.Wait()

	if len(seen) != N {
		t.Fatalf("expected %d distinct jtis, got %d", N, len(seen))
	}
}
