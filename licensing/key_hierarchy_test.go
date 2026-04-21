package licensing_test

// Tests for the key hierarchy, rotation, attestations, and encrypted-at-rest
// storage. Exercises each backend (Ed25519, RSA-PSS, HMAC) to catch any
// alg-specific misrouting in the private-material pipeline.
//
// Placed in package licensing_test so the tests can legally import the
// backend packages (which themselves import licensing).

import (
	"errors"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	hmacbe "github.com/AnoRebel/licensing/licensing/crypto/hmac"
	rsabe "github.com/AnoRebel/licensing/licensing/crypto/rsa"
)

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

// newHierarchy spins up a KeyHierarchy with all three backends registered.
// Any test that needs only one alg can still use this — registering extra
// backends is free.
func newHierarchy(t *testing.T) *lic.KeyHierarchy {
	t.Helper()
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed.New()); err != nil {
		t.Fatalf("register ed25519: %v", err)
	}
	if err := reg.Register(rsabe.New()); err != nil {
		t.Fatalf("register rsa: %v", err)
	}
	if err := reg.Register(hmacbe.New()); err != nil {
		t.Fatalf("register hmac: %v", err)
	}
	kh, err := lic.NewKeyHierarchy(lic.KeyHierarchyOptions{
		Store:    lic.NewInMemoryKeyStore(),
		Registry: reg,
	})
	if err != nil {
		t.Fatalf("new hierarchy: %v", err)
	}
	return kh
}

func strPtr(s string) *string { return &s }

// -----------------------------------------------------------------------
// InMemoryKeyStore basics
// -----------------------------------------------------------------------

func TestInMemoryKeyStore_PutGetFind(t *testing.T) {
	s := lic.NewInMemoryKeyStore()
	rec := lic.LicenseKey{
		ID:        "id-1",
		Kid:       "kid-1",
		Alg:       lic.AlgEd25519,
		Role:      lic.RoleSigning,
		State:     lic.StateActive,
		PublicPem: "pub",
		CreatedAt: "2026-01-01T00:00:00Z",
		UpdatedAt: "2026-01-01T00:00:00Z",
		NotBefore: "2026-01-01T00:00:00Z",
	}
	if err := s.Put(rec); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := s.Get("id-1")
	if err != nil || got == nil || got.Kid != "kid-1" {
		t.Fatalf("get: %v %+v", err, got)
	}
	got2, err := s.FindByKid("kid-1")
	if err != nil || got2 == nil || got2.ID != "id-1" {
		t.Fatalf("findbykid: %v %+v", err, got2)
	}
	missing, err := s.FindByKid("nope")
	if err != nil || missing != nil {
		t.Fatalf("expected (nil,nil), got %+v, %v", missing, err)
	}
}

func TestInMemoryKeyStore_DuplicateKidRejected(t *testing.T) {
	s := lic.NewInMemoryKeyStore()
	rec := lic.LicenseKey{ID: "id-a", Kid: "dup", Alg: lic.AlgEd25519, Role: lic.RoleSigning, State: lic.StateActive}
	if err := s.Put(rec); err != nil {
		t.Fatal(err)
	}
	dup := rec
	dup.ID = "id-b"
	err := s.Put(dup)
	if !errors.Is(err, lic.ErrUniqueConstraintViolation) {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

func TestInMemoryKeyStore_ListFilters(t *testing.T) {
	s := lic.NewInMemoryKeyStore()
	mk := func(id, kid string, role lic.KeyRole, state lic.KeyState, alg lic.KeyAlg, scope *string) lic.LicenseKey {
		return lic.LicenseKey{
			ID: id, Kid: kid, Alg: alg, Role: role, State: state,
			ScopeID:   scope,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
			NotBefore: "2026-01-01T00:00:00Z",
		}
	}
	s.Put(mk("1", "k1", lic.RoleRoot, lic.StateActive, lic.AlgEd25519, nil))
	s.Put(mk("2", "k2", lic.RoleSigning, lic.StateActive, lic.AlgEd25519, nil))
	s.Put(mk("3", "k3", lic.RoleSigning, lic.StateRetiring, lic.AlgEd25519, nil))
	s.Put(mk("4", "k4", lic.RoleSigning, lic.StateActive, lic.AlgEd25519, strPtr("scope-a")))

	// No filter: 4 rows.
	all, _ := s.List(lic.KeyStoreFilter{})
	if len(all) != 4 {
		t.Fatalf("expected 4, got %d", len(all))
	}

	// Active signing, global scope only.
	active := lic.StateActive
	role := lic.RoleSigning
	out, _ := s.List(lic.KeyStoreFilter{
		ScopeID: nil, ScopeIDSet: true, Role: &role, State: &active,
	})
	if len(out) != 1 || out[0].ID != "2" {
		t.Fatalf("expected [id=2], got %+v", out)
	}

	// Scoped scope-a.
	out2, _ := s.List(lic.KeyStoreFilter{
		ScopeID: strPtr("scope-a"), ScopeIDSet: true, Role: &role,
	})
	if len(out2) != 1 || out2[0].ID != "4" {
		t.Fatalf("expected [id=4], got %+v", out2)
	}
}

// -----------------------------------------------------------------------
// GenerateRoot
// -----------------------------------------------------------------------

func TestKeyHierarchy_GenerateRoot_Ed25519(t *testing.T) {
	kh := newHierarchy(t)
	rec, err := kh.GenerateRoot(lic.GenerateRootOptions{
		Alg:        lic.AlgEd25519,
		Passphrase: "root-pw",
	})
	if err != nil {
		t.Fatalf("generate root: %v", err)
	}
	if rec.Role != lic.RoleRoot || rec.State != lic.StateActive {
		t.Fatalf("unexpected role/state: %s/%s", rec.Role, rec.State)
	}
	if rec.Alg != lic.AlgEd25519 {
		t.Fatalf("alg: %s", rec.Alg)
	}
	if rec.PrivatePemEnc == nil || !strings.Contains(*rec.PrivatePemEnc, "ENCRYPTED PRIVATE KEY") {
		t.Fatalf("expected ENCRYPTED PRIVATE KEY armor, got %v", rec.PrivatePemEnc)
	}
	if !strings.Contains(rec.PublicPem, "PUBLIC KEY") {
		t.Fatalf("expected PUBLIC KEY armor, got %q", rec.PublicPem)
	}
	if rec.ScopeID != nil {
		t.Fatalf("expected global scope, got %q", *rec.ScopeID)
	}
}

func TestKeyHierarchy_GenerateRoot_RejectsEmptyPassphrase(t *testing.T) {
	kh := newHierarchy(t)
	_, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: ""})
	if !errors.Is(err, lic.ErrMissingKeyPassphrase) {
		t.Fatalf("expected MissingKeyPassphrase, got %v", err)
	}
}

func TestKeyHierarchy_GenerateRoot_UnsupportedAlgRejected(t *testing.T) {
	reg := lic.NewAlgorithmRegistry()
	// Only register ed25519; request rsa.
	reg.Register(ed.New())
	kh, err := lic.NewKeyHierarchy(lic.KeyHierarchyOptions{
		Store:    lic.NewInMemoryKeyStore(),
		Registry: reg,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgRSAPSS, Passphrase: "pw"})
	if !errors.Is(err, lic.ErrUnsupportedAlgorithm) {
		t.Fatalf("expected UnsupportedAlgorithm, got %v", err)
	}
}

// -----------------------------------------------------------------------
// IssueSigning
// -----------------------------------------------------------------------

func TestKeyHierarchy_IssueSigning_Ed25519(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	signing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if err != nil {
		t.Fatalf("issue signing: %v", err)
	}
	if signing.Role != lic.RoleSigning || signing.State != lic.StateActive {
		t.Fatalf("unexpected role/state: %s/%s", signing.Role, signing.State)
	}
	att, ok := signing.Meta["root_attestation"].(map[string]any)
	if !ok {
		t.Fatalf("expected root_attestation meta; got %+v", signing.Meta)
	}
	rootKid, _ := att["root_kid"].(string)
	sig, _ := att["signature"].(string)
	if rootKid != root.Kid || sig == "" {
		t.Fatalf("bad attestation fields: kid=%q sig=%q", rootKid, sig)
	}
}

func TestKeyHierarchy_IssueSigning_RefusesDuplicateActive(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	opts := lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	}
	if _, err := kh.IssueSigning(opts); err != nil {
		t.Fatal(err)
	}
	_, err = kh.IssueSigning(opts)
	if !errors.Is(err, lic.ErrUniqueConstraintViolation) {
		t.Fatalf("expected UniqueConstraintViolation, got %v", err)
	}
}

func TestKeyHierarchy_IssueSigning_AlgMismatch(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgRSAPSS, // different alg than root
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrAlgorithmMismatch) {
		t.Fatalf("expected AlgorithmMismatch, got %v", err)
	}
}

func TestKeyHierarchy_IssueSigning_UnknownRoot(t *testing.T) {
	kh := newHierarchy(t)
	_, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           "does-not-exist",
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrUnknownKid) {
		t.Fatalf("expected UnknownKid, got %v", err)
	}
}

func TestKeyHierarchy_IssueSigning_WrongRootPassphrase(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "WRONG",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrKeyDecryptionFailed) {
		t.Fatalf("expected KeyDecryptionFailed, got %v", err)
	}
}

func TestKeyHierarchy_IssueSigning_EmptyPassphraseRejected(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrMissingKeyPassphrase) {
		t.Fatalf("expected MissingKeyPassphrase, got %v", err)
	}
}

// -----------------------------------------------------------------------
// RotateSigning
// -----------------------------------------------------------------------

func TestKeyHierarchy_RotateSigning_Ed25519(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	outgoing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw1",
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := kh.RotateSigning(lic.RotateSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw2",
	})
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if res.Outgoing.ID != outgoing.ID {
		t.Fatalf("outgoing mismatch")
	}
	if res.Outgoing.State != lic.StateRetiring || res.Outgoing.RotatedAt == nil {
		t.Fatalf("outgoing not demoted: state=%s rotatedAt=%v", res.Outgoing.State, res.Outgoing.RotatedAt)
	}
	if res.Incoming.State != lic.StateActive {
		t.Fatalf("incoming state: %s", res.Incoming.State)
	}
	if res.Incoming.RotatedFrom == nil || *res.Incoming.RotatedFrom != outgoing.ID {
		t.Fatalf("incoming.RotatedFrom bad: %+v", res.Incoming.RotatedFrom)
	}
	// After rotation: exactly one active signing key.
	active := lic.StateActive
	role := lic.RoleSigning
	actives, err := kh.List(lic.KeyStoreFilter{
		ScopeID: nil, ScopeIDSet: true, Role: &role, State: &active, Alg: func() *lic.KeyAlg { a := lic.AlgEd25519; return &a }(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(actives) != 1 || actives[0].ID != res.Incoming.ID {
		t.Fatalf("expected one active = incoming, got %+v", actives)
	}
}

func TestKeyHierarchy_RotateSigning_ClampsOutgoingNotAfter(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw1",
	})
	if err != nil {
		t.Fatal(err)
	}
	retireAt := "2030-01-01T00:00:00Z"
	res, err := kh.RotateSigning(lic.RotateSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw2",
		RetireOutgoingAt:  &retireAt,
		RetireOutgoingSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outgoing.NotAfter == nil || *res.Outgoing.NotAfter != retireAt {
		t.Fatalf("outgoing NotAfter not clamped: %+v", res.Outgoing.NotAfter)
	}
}

func TestKeyHierarchy_RotateSigning_NoActiveToRotate(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kh.RotateSigning(lic.RotateSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

// -----------------------------------------------------------------------
// VerifyAttestation
// -----------------------------------------------------------------------

func TestKeyHierarchy_VerifyAttestation_Ed25519(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	signing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := kh.VerifyAttestation(signing.Kid)
	if err != nil {
		t.Fatalf("verify attestation: %v", err)
	}
	if !ok {
		t.Fatal("attestation rejected; expected accept")
	}
}

func TestKeyHierarchy_VerifyAttestation_RSA(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgRSAPSS, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	signing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgRSAPSS,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := kh.VerifyAttestation(signing.Kid)
	if err != nil {
		t.Fatalf("verify attestation: %v", err)
	}
	if !ok {
		t.Fatal("RSA attestation rejected; expected accept")
	}
}

func TestKeyHierarchy_VerifyAttestation_UnknownSigning(t *testing.T) {
	kh := newHierarchy(t)
	ok, err := kh.VerifyAttestation("does-not-exist")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("expected false for unknown kid")
	}
}

// -----------------------------------------------------------------------
// ImportSigningPrivate
// -----------------------------------------------------------------------

func TestKeyHierarchy_ImportSigningPrivate_RoundTrip(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	signing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if err != nil {
		t.Fatal(err)
	}
	rec, handle, err := kh.ImportSigningPrivate(signing.Kid, "spw")
	if err != nil {
		t.Fatalf("import signing private: %v", err)
	}
	if rec.ID != signing.ID {
		t.Fatalf("record mismatch")
	}
	// Sanity: signing handle is non-nil and usable via the registered backend.
	reg := lic.NewAlgorithmRegistry()
	_ = reg.Register(ed.New())
	be, _ := reg.Get(lic.AlgEd25519)
	sig, err := be.Sign(handle, []byte("hello"))
	if err != nil {
		t.Fatalf("sign with imported handle: %v", err)
	}
	if len(sig) != 64 {
		t.Fatalf("expected 64-byte ed25519 signature, got %d", len(sig))
	}
}

func TestKeyHierarchy_ImportSigningPrivate_WrongPassphrase(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	signing, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgEd25519,
		RootKid:           root.Kid,
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = kh.ImportSigningPrivate(signing.Kid, "WRONG")
	if !errors.Is(err, lic.ErrKeyDecryptionFailed) {
		t.Fatalf("expected KeyDecryptionFailed, got %v", err)
	}
}

func TestKeyHierarchy_ImportSigningPrivate_EmptyPassphraseRejected(t *testing.T) {
	kh := newHierarchy(t)
	_, _, err := kh.ImportSigningPrivate("anything", "")
	if !errors.Is(err, lic.ErrMissingKeyPassphrase) {
		t.Fatalf("expected MissingKeyPassphrase, got %v", err)
	}
}

func TestKeyHierarchy_ImportSigningPrivate_RefusesRoot(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = kh.ImportSigningPrivate(root.Kid, "rpw")
	if !errors.Is(err, lic.ErrTokenMalformed) {
		t.Fatalf("expected TokenMalformed, got %v", err)
	}
}

func TestKeyHierarchy_ImportSigningPrivate_UnknownKid(t *testing.T) {
	kh := newHierarchy(t)
	_, _, err := kh.ImportSigningPrivate("does-not-exist", "pw")
	if !errors.Is(err, lic.ErrUnknownKid) {
		t.Fatalf("expected UnknownKid, got %v", err)
	}
}

// -----------------------------------------------------------------------
// FindByKid
// -----------------------------------------------------------------------

func TestKeyHierarchy_FindByKid(t *testing.T) {
	kh := newHierarchy(t)
	root, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgEd25519, Passphrase: "rpw"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := kh.FindByKid(root.Kid)
	if err != nil || got == nil || got.ID != root.ID {
		t.Fatalf("findbykid roundtrip failed: got=%+v err=%v", got, err)
	}
	missing, err := kh.FindByKid("no-such-kid")
	if err != nil || missing != nil {
		t.Fatalf("expected (nil,nil) for missing kid, got %+v %v", missing, err)
	}
}

// -----------------------------------------------------------------------
// HMAC rejection — symmetric algs have no attestation chain
// -----------------------------------------------------------------------

func TestKeyHierarchy_RejectsHMACRoot(t *testing.T) {
	kh := newHierarchy(t)
	_, err := kh.GenerateRoot(lic.GenerateRootOptions{Alg: lic.AlgHS256, Passphrase: "rpw"})
	if !errors.Is(err, lic.ErrUnsupportedAlgorithm) {
		t.Fatalf("expected UnsupportedAlgorithm, got %v", err)
	}
}

func TestKeyHierarchy_RejectsHMACSigning(t *testing.T) {
	kh := newHierarchy(t)
	// Even if caller fabricates a (nonexistent) root kid, HMAC must be
	// refused before we look up the root.
	_, err := kh.IssueSigning(lic.IssueSigningOptions{
		Alg:               lic.AlgHS256,
		RootKid:           "fake",
		RootPassphrase:    "rpw",
		SigningPassphrase: "spw",
	})
	if !errors.Is(err, lic.ErrUnsupportedAlgorithm) {
		t.Fatalf("expected UnsupportedAlgorithm, got %v", err)
	}
}

// -----------------------------------------------------------------------
// Scoped keys
// -----------------------------------------------------------------------

func TestKeyHierarchy_PerScope_Independence(t *testing.T) {
	kh := newHierarchy(t)
	// Two scopes can each have an active signing key without colliding.
	rootA, err := kh.GenerateRoot(lic.GenerateRootOptions{
		Alg: lic.AlgEd25519, ScopeID: strPtr("tenant-a"), Passphrase: "rpw",
	})
	if err != nil {
		t.Fatal(err)
	}
	rootB, err := kh.GenerateRoot(lic.GenerateRootOptions{
		Alg: lic.AlgEd25519, ScopeID: strPtr("tenant-b"), Passphrase: "rpw",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kh.IssueSigning(lic.IssueSigningOptions{
		ScopeID: strPtr("tenant-a"), Alg: lic.AlgEd25519,
		RootKid: rootA.Kid, RootPassphrase: "rpw", SigningPassphrase: "spw",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := kh.IssueSigning(lic.IssueSigningOptions{
		ScopeID: strPtr("tenant-b"), Alg: lic.AlgEd25519,
		RootKid: rootB.Kid, RootPassphrase: "rpw", SigningPassphrase: "spw",
	}); err != nil {
		t.Fatalf("second scope issuance should not trigger uniqueness: %v", err)
	}
}
