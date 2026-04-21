package licensing

// Two-level key hierarchy with rotation and encrypted-at-rest storage.
// Mirrors @anorebel/licensing/key-hierarchy.ts.
//
//	┌─────────────┐        certifies         ┌──────────────────┐
//	│  Root key   │ ────────────────────────▶│  Signing key(s)  │
//	│ (per-scope  │         via              │  one `active`    │
//	│  or global) │      signed bundle       │  n `retiring`    │
//	└─────────────┘                          └──────────────────┘
//	                                                 │
//	                                                 ▼
//	                                         LIC1 tokens carry
//	                                         `kid = signing.kid`
//
// Invariants enforced:
//
//   - At most one `active` signing key per (scope_id, alg, role='signing').
//   - Rotation never destroys outstanding tokens: the outgoing key becomes
//     `retiring` (still valid for Verify) until its NotAfter.
//   - Root keys never sign LIC1 tokens — only attestations over signing-key
//     public material.
//   - Private material is stored only as WrapEncryptedPKCS8 output;
//     plaintext never touches the KeyStore.
//   - Passphrase never logged, never returned.

import (
	stded "crypto/ed25519"
	stdrsa "crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"sort"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// KeyStore contract
// -----------------------------------------------------------------------

// KeyStore is the minimal persistence contract for LicenseKey records.
// Production adapters live under licensing/storage/*; this file ships an
// in-memory implementation for the key-hierarchy layer itself and for tests.
type KeyStore interface {
	Put(record LicenseKey) error
	Get(id string) (*LicenseKey, error)
	FindByKid(kid string) (*LicenseKey, error)
	List(filter KeyStoreFilter) ([]LicenseKey, error)
	// Update atomically replaces a record. Returns ErrTokenMalformed if id
	// is unknown or if next.ID does not match id.
	Update(id string, next LicenseKey) error
}

// KeyStoreFilter narrows List results. A nil pointer field means "don't
// filter on that field"; passing a pointer to the zero value DOES filter.
type KeyStoreFilter struct {
	ScopeID    *string
	Role       *KeyRole
	State      *KeyState
	Alg        *KeyAlg
	ScopeIDSet bool
}

// InMemoryKeyStore is a KeyStore backed by in-process maps. Safe for
// concurrent use.
type InMemoryKeyStore struct {
	byID  map[string]LicenseKey
	byKid map[string]string
	mu    sync.RWMutex
}

// NewInMemoryKeyStore constructs an empty in-memory store.
func NewInMemoryKeyStore() *InMemoryKeyStore {
	return &InMemoryKeyStore{
		byID:  make(map[string]LicenseKey),
		byKid: make(map[string]string),
	}
}

// Put inserts a key record. Returns UniqueConstraintViolation if another
// record already claims this kid.
func (s *InMemoryKeyStore) Put(rec LicenseKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existingID, ok := s.byKid[rec.Kid]; ok && existingID != rec.ID {
		return newError(CodeUniqueConstraintViolation,
			fmt.Sprintf("kid already in use by another key: %s", rec.Kid),
			map[string]any{"constraint": "kid", "value": rec.Kid})
	}
	s.byID[rec.ID] = rec
	s.byKid[rec.Kid] = rec.ID
	return nil
}

// Get fetches the record.
func (s *InMemoryKeyStore) Get(id string) (*LicenseKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.byID[id]
	if !ok {
		return nil, nil
	}
	cp := rec
	return &cp, nil
}

// FindByKid finds by kid.
func (s *InMemoryKeyStore) FindByKid(kid string) (*LicenseKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byKid[kid]
	if !ok {
		return nil, nil
	}
	rec := s.byID[id]
	return &rec, nil
}

// List lists the record.
func (s *InMemoryKeyStore) List(filter KeyStoreFilter) ([]LicenseKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]LicenseKey, 0, len(s.byID))
	for _, rec := range s.byID {
		if filter.ScopeIDSet {
			if !scopeEq(rec.ScopeID, filter.ScopeID) {
				continue
			}
		}
		if filter.Role != nil && rec.Role != *filter.Role {
			continue
		}
		if filter.State != nil && rec.State != *filter.State {
			continue
		}
		if filter.Alg != nil && rec.Alg != *filter.Alg {
			continue
		}
		out = append(out, rec)
	}
	// Stable order: by CreatedAt then ID.
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// Update updates the record.
func (s *InMemoryKeyStore) Update(id string, next LicenseKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byID[id]; !ok {
		return newError(CodeTokenMalformed,
			fmt.Sprintf("key not found: %s", id), nil)
	}
	if id != next.ID {
		return newError(CodeTokenMalformed,
			"update cannot change id", nil)
	}
	s.byID[id] = next
	s.byKid[next.Kid] = id
	return nil
}

func scopeEq(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// -----------------------------------------------------------------------
// Clock
// -----------------------------------------------------------------------

// Clock abstracts wall-clock access so tests can pin timestamps. NowISO
// returns an ISO-8601 / RFC 3339 string matching the TS port.
type Clock interface {
	NowISO() string
}

// SystemClock reads the real clock.
type SystemClock struct{}

// NowISO returns the current UTC time formatted as RFC 3339 with nanosecond precision.
func (SystemClock) NowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// -----------------------------------------------------------------------
// KeyHierarchy orchestration
// -----------------------------------------------------------------------

// KeyHierarchyOptions configures a KeyHierarchy.
type KeyHierarchyOptions struct {
	Store    KeyStore
	Registry *AlgorithmRegistry
	Clock    Clock
	// MakeKid produces a deterministic kid given a role and generated id.
	// Defaults to "<role>-<first12hex-of-id>" — tests may override for
	// stable fixtures.
	MakeKid func(role KeyRole, id string) string
}

// KeyHierarchy wraps a KeyStore + AlgorithmRegistry. All methods are
// idempotent: they either complete fully and persist, or return an error
// before mutating state.
type KeyHierarchy struct {
	store    KeyStore
	registry *AlgorithmRegistry
	clock    Clock
	makeKid  func(role KeyRole, id string) string
}

// NewKeyHierarchy constructs a KeyHierarchy.
func NewKeyHierarchy(opts KeyHierarchyOptions) (*KeyHierarchy, error) {
	if opts.Store == nil {
		return nil, fmt.Errorf("key hierarchy: Store is required")
	}
	if opts.Registry == nil {
		return nil, fmt.Errorf("key hierarchy: Registry is required")
	}
	kh := &KeyHierarchy{
		store:    opts.Store,
		registry: opts.Registry,
		clock:    opts.Clock,
		makeKid:  opts.MakeKid,
	}
	if kh.clock == nil {
		kh.clock = SystemClock{}
	}
	if kh.makeKid == nil {
		kh.makeKid = defaultMakeKid
	}
	return kh, nil
}

// defaultMakeKid packs role + first 12 hex chars of the id so collisions
// within the same millisecond remain unlikely.
func defaultMakeKid(role KeyRole, id string) string {
	// id is a UUID-like string; strip dashes and take the leading 12 hex.
	clean := make([]byte, 0, 32)
	for i := 0; i < len(id); i++ {
		if id[i] != '-' {
			clean = append(clean, id[i])
		}
	}
	if len(clean) > 12 {
		clean = clean[:12]
	}
	return fmt.Sprintf("%s-%s", role, string(clean))
}

func (kh *KeyHierarchy) backend(alg KeyAlg) (SignatureBackend, error) {
	return kh.registry.Get(alg)
}

// ensureAsymmetricAlg rejects symmetric algorithms from the hierarchy. The
// hierarchy's root→signing attestation chain only makes sense when the root
// can certify a public key the verifier can independently trust — symmetric
// keys have no separable public half, so there is nothing to attest. HMAC
// secrets should be managed outside this layer (e.g., directly via the
// backend's ImportPrivate).
func ensureAsymmetricAlg(alg KeyAlg) error {
	switch alg {
	case AlgEd25519, AlgRSAPSS:
		return nil
	case AlgHS256:
		return newError(CodeUnsupportedAlgorithm,
			"symmetric algorithms (hs256) are not supported by the key hierarchy; manage HMAC secrets outside this layer",
			map[string]any{"alg": string(alg)})
	default:
		return newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("unsupported alg for key hierarchy: %s", alg),
			map[string]any{"alg": string(alg)})
	}
}

// -----------------------------------------------------------------------
// GenerateRoot
// -----------------------------------------------------------------------

// GenerateRootOptions configures KeyHierarchy.GenerateRoot.
type GenerateRootOptions struct {
	ScopeID    *string
	NotAfter   *string
	Meta       map[string]any
	Alg        KeyAlg
	Passphrase string
	Kid        string
}

// GenerateRoot creates a fresh root key. Root keys sign attestations over
// signing-key public material but NEVER LIC1 tokens. An empty passphrase is
// refused with ErrMissingKeyPassphrase. Symmetric algorithms (HMAC) are
// rejected — the hierarchy only makes sense for algs with a public-key
// attestation chain.
func (kh *KeyHierarchy) GenerateRoot(opts GenerateRootOptions) (*LicenseKey, error) {
	if opts.Passphrase == "" {
		return nil, newError(CodeMissingKeyPassphrase,
			"GenerateRoot requires a non-empty passphrase", nil)
	}
	if err := ensureAsymmetricAlg(opts.Alg); err != nil {
		return nil, err
	}
	be, err := kh.backend(opts.Alg)
	if err != nil {
		return nil, err
	}
	pemMat, rawMat, err := be.Generate(opts.Passphrase)
	if err != nil {
		return nil, err
	}

	id := NewUUIDv7()
	kid := opts.Kid
	if kid == "" {
		kid = kh.makeKid(RoleRoot, id)
	}
	now := kh.clock.NowISO()

	privateDER, err := privateMaterialToDER(pemMat, rawMat)
	if err != nil {
		return nil, err
	}
	var privateEnc *string
	if privateDER != nil {
		wrapped, wErr := WrapEncryptedPKCS8(privateDER, opts.Passphrase)
		if wErr != nil {
			return nil, wErr
		}
		privateEnc = &wrapped
	}

	meta := opts.Meta
	if meta == nil {
		meta = map[string]any{}
	}

	rec := LicenseKey{
		ID:            id,
		ScopeID:       opts.ScopeID,
		Kid:           kid,
		Alg:           opts.Alg,
		Role:          RoleRoot,
		State:         StateActive,
		PublicPem:     pemMat.PublicPem,
		PrivatePemEnc: privateEnc,
		NotBefore:     now,
		NotAfter:      opts.NotAfter,
		Meta:          meta,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := kh.store.Put(rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// -----------------------------------------------------------------------
// IssueSigning
// -----------------------------------------------------------------------

// IssueSigningOptions configures KeyHierarchy.IssueSigning.
type IssueSigningOptions struct {
	ScopeID           *string
	Alg               KeyAlg
	RootKid           string
	RootPassphrase    string
	SigningPassphrase string
	NotAfter          *string
	Kid               string
}

// IssueSigning creates a new signing key under a given root. There must NOT
// already be an active signing key for (ScopeID, Alg) — callers should use
// RotateSigning to replace one.
func (kh *KeyHierarchy) IssueSigning(opts IssueSigningOptions) (*LicenseKey, error) {
	if opts.RootPassphrase == "" || opts.SigningPassphrase == "" {
		return nil, newError(CodeMissingKeyPassphrase,
			"IssueSigning requires non-empty root and signing passphrases", nil)
	}
	if err := ensureAsymmetricAlg(opts.Alg); err != nil {
		return nil, err
	}

	activeState := StateActive
	signingRole := RoleSigning
	existing, err := kh.store.List(KeyStoreFilter{
		ScopeID:    opts.ScopeID,
		ScopeIDSet: true,
		Role:       &signingRole,
		State:      &activeState,
		Alg:        &opts.Alg,
	})
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		scopeDesc := "global"
		if opts.ScopeID != nil {
			scopeDesc = *opts.ScopeID
		}
		return nil, newError(CodeUniqueConstraintViolation,
			fmt.Sprintf("an active signing key already exists for scope=%s alg=%s", scopeDesc, opts.Alg),
			map[string]any{"constraint": "active_signing_per_scope"})
	}

	root, err := kh.requireRoot(opts.RootKid, opts.Alg, opts.ScopeID)
	if err != nil {
		return nil, err
	}

	be, err := kh.backend(opts.Alg)
	if err != nil {
		return nil, err
	}
	pemMat, rawMat, err := be.Generate(opts.SigningPassphrase)
	if err != nil {
		return nil, err
	}

	id := NewUUIDv7()
	kid := opts.Kid
	if kid == "" {
		kid = kh.makeKid(RoleSigning, id)
	}
	now := kh.clock.NowISO()

	privateDER, err := privateMaterialToDER(pemMat, rawMat)
	if err != nil {
		return nil, err
	}
	var privateEnc *string
	if privateDER != nil {
		wrapped, wErr := WrapEncryptedPKCS8(privateDER, opts.SigningPassphrase)
		if wErr != nil {
			return nil, wErr
		}
		privateEnc = &wrapped
	}

	attestation, err := kh.attestSigning(root, opts.RootPassphrase, signingAttest{
		Kid:       kid,
		Alg:       opts.Alg,
		PublicRaw: rawMat.PublicRaw,
		NotBefore: now,
		NotAfter:  opts.NotAfter,
	})
	if err != nil {
		return nil, err
	}

	rec := LicenseKey{
		ID:            id,
		ScopeID:       opts.ScopeID,
		Kid:           kid,
		Alg:           opts.Alg,
		Role:          RoleSigning,
		State:         StateActive,
		PublicPem:     pemMat.PublicPem,
		PrivatePemEnc: privateEnc,
		NotBefore:     now,
		NotAfter:      opts.NotAfter,
		Meta: map[string]any{
			"root_attestation": map[string]any{
				"root_kid":  attestation.RootKid,
				"signature": Base64urlEncode(attestation.Signature),
			},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := kh.store.Put(rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// -----------------------------------------------------------------------
// RotateSigning
// -----------------------------------------------------------------------

// RotateSigningOptions configures KeyHierarchy.RotateSigning.
type RotateSigningOptions struct {
	ScopeID           *string
	RetireOutgoingAt  *string
	Alg               KeyAlg
	RootKid           string
	RootPassphrase    string
	SigningPassphrase string
	Kid               string
	RetireOutgoingSet bool
}

// RotateResult reports the two keys touched by a rotation.
type RotateResult struct {
	Outgoing LicenseKey
	Incoming LicenseKey
}

// RotateSigning retires the active signing key and issues a new one certified
// by the same root.
func (kh *KeyHierarchy) RotateSigning(opts RotateSigningOptions) (*RotateResult, error) {
	activeState := StateActive
	signingRole := RoleSigning
	actives, err := kh.store.List(KeyStoreFilter{
		ScopeID:    opts.ScopeID,
		ScopeIDSet: true,
		Role:       &signingRole,
		State:      &activeState,
		Alg:        &opts.Alg,
	})
	if err != nil {
		return nil, err
	}
	scopeDesc := "global"
	if opts.ScopeID != nil {
		scopeDesc = *opts.ScopeID
	}
	if len(actives) == 0 {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("no active signing key to rotate for scope=%s alg=%s", scopeDesc, opts.Alg), nil)
	}
	if len(actives) > 1 {
		return nil, newError(CodeUniqueConstraintViolation,
			fmt.Sprintf("invariant violation: %d active signing keys for scope=%s alg=%s", len(actives), scopeDesc, opts.Alg),
			map[string]any{"constraint": "active_signing_per_scope"})
	}
	outgoingActive := actives[0]

	// Demote outgoing to retiring.
	now := kh.clock.NowISO()
	retiring := outgoingActive
	retiring.State = StateRetiring
	if opts.RetireOutgoingSet {
		retiring.NotAfter = opts.RetireOutgoingAt
	}
	retiring.RotatedAt = &now
	retiring.UpdatedAt = now
	if err := kh.store.Update(outgoingActive.ID, retiring); err != nil {
		return nil, err
	}

	// Issue incoming as active, linked back to outgoing.
	incoming, err := kh.IssueSigning(IssueSigningOptions{
		ScopeID:           opts.ScopeID,
		Alg:               opts.Alg,
		RootKid:           opts.RootKid,
		RootPassphrase:    opts.RootPassphrase,
		SigningPassphrase: opts.SigningPassphrase,
		Kid:               opts.Kid,
	})
	if err != nil {
		return nil, err
	}
	linked := *incoming
	linked.RotatedFrom = &outgoingActive.ID
	linked.UpdatedAt = now
	if err := kh.store.Update(incoming.ID, linked); err != nil {
		return nil, err
	}

	return &RotateResult{Outgoing: retiring, Incoming: linked}, nil
}

// -----------------------------------------------------------------------
// Reads + auxiliary ops
// -----------------------------------------------------------------------

// List returns every key record matching filter.
func (kh *KeyHierarchy) List(filter KeyStoreFilter) ([]LicenseKey, error) {
	return kh.store.List(filter)
}

// FindByKid returns the record with kid, or (nil, nil) if unknown.
func (kh *KeyHierarchy) FindByKid(kid string) (*LicenseKey, error) {
	return kh.store.FindByKid(kid)
}

// ImportSigningPrivate decrypts a stored signing key's private material and
// hands back an importable PrivateKeyHandle. Caller is responsible for
// releasing the handle after use. Refuses non-signing keys and empty
// passphrases.
func (kh *KeyHierarchy) ImportSigningPrivate(kid, passphrase string) (*LicenseKey, PrivateKeyHandle, error) {
	if passphrase == "" {
		return nil, nil, newError(CodeMissingKeyPassphrase,
			"ImportSigningPrivate requires a non-empty passphrase", nil)
	}
	rec, err := kh.store.FindByKid(kid)
	if err != nil {
		return nil, nil, err
	}
	if rec == nil {
		return nil, nil, newError(CodeUnknownKid,
			fmt.Sprintf("unknown kid: %s", kid),
			map[string]any{"kid": kid})
	}
	if rec.Role != RoleSigning {
		return nil, nil, newError(CodeTokenMalformed,
			fmt.Sprintf("key %s has role=%s; only signing keys may sign LIC1 tokens", kid, rec.Role), nil)
	}
	if rec.PrivatePemEnc == nil {
		return nil, nil, newError(CodeTokenMalformed,
			fmt.Sprintf("key %s holds only public material", kid), nil)
	}
	be, err := kh.backend(rec.Alg)
	if err != nil {
		return nil, nil, err
	}
	plaintextDER, err := UnwrapEncryptedPKCS8(*rec.PrivatePemEnc, passphrase)
	if err != nil {
		return nil, nil, err
	}
	pemText := derToPKCS8PEM(plaintextDER)
	handle, err := be.ImportPrivate(KeyMaterial{
		Pem: PemKeyMaterial{PrivatePem: pemText, PublicPem: rec.PublicPem},
	}, passphrase)
	if err != nil {
		return nil, nil, err
	}
	return rec, handle, nil
}

// VerifyAttestation re-verifies a signing key's root attestation. Used by
// operators doing a post-rotation audit; the LIC1 verify path itself does
// not require a valid attestation chain.
func (kh *KeyHierarchy) VerifyAttestation(signingKid string) (bool, error) {
	signing, err := kh.store.FindByKid(signingKid)
	if err != nil {
		return false, err
	}
	if signing == nil || signing.Role != RoleSigning {
		return false, nil
	}
	att, ok := signing.Meta["root_attestation"].(map[string]any)
	if !ok {
		return false, nil
	}
	rootKid, _ := att["root_kid"].(string)
	sigB64, _ := att["signature"].(string)
	if rootKid == "" || sigB64 == "" {
		return false, nil
	}
	root, err := kh.store.FindByKid(rootKid)
	if err != nil {
		return false, err
	}
	if root == nil || root.Role != RoleRoot || root.Alg != signing.Alg {
		return false, nil
	}
	be, err := kh.backend(signing.Alg)
	if err != nil {
		return false, err
	}
	pubHandle, err := be.ImportPublic(KeyMaterial{
		Pem: PemKeyMaterial{PublicPem: root.PublicPem},
	})
	if err != nil {
		return false, err
	}
	publicRaw, err := extractPublicRawFromRecord(signing)
	if err != nil {
		return false, err
	}
	canonical, err := attestationCanonical(signing.Kid, signing.Alg, publicRaw, signing.NotBefore, signing.NotAfter)
	if err != nil {
		return false, err
	}
	sig, err := Base64urlDecode(sigB64)
	if err != nil {
		return false, nil
	}
	return be.Verify(pubHandle, canonical, sig)
}

// -----------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------

func (kh *KeyHierarchy) requireRoot(rootKid string, alg KeyAlg, scopeID *string) (*LicenseKey, error) {
	rec, err := kh.store.FindByKid(rootKid)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, newError(CodeUnknownKid,
			fmt.Sprintf("unknown root kid: %s", rootKid),
			map[string]any{"kid": rootKid})
	}
	if rec.Role != RoleRoot {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("kid %s is not a root key (role=%s)", rootKid, rec.Role), nil)
	}
	if rec.Alg != alg {
		return nil, newError(CodeAlgorithmMismatch,
			fmt.Sprintf("root alg %s does not match requested alg %s", rec.Alg, alg),
			map[string]any{"expected": string(rec.Alg), "actual": string(alg)})
	}
	if !scopeEq(rec.ScopeID, scopeID) {
		rootScope := "global"
		if rec.ScopeID != nil {
			rootScope = *rec.ScopeID
		}
		reqScope := "global"
		if scopeID != nil {
			reqScope = *scopeID
		}
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("root scope (%s) ≠ requested scope (%s)", rootScope, reqScope), nil)
	}
	return rec, nil
}

type signingAttest struct {
	NotAfter  *string
	Kid       string
	Alg       KeyAlg
	NotBefore string
	PublicRaw []byte
}

type attestationOut struct {
	RootKid   string
	Canonical []byte
	Signature []byte
}

func (kh *KeyHierarchy) attestSigning(root *LicenseKey, passphrase string, s signingAttest) (*attestationOut, error) {
	if root.PrivatePemEnc == nil {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("root %s holds only public material", root.Kid), nil)
	}
	be, err := kh.backend(root.Alg)
	if err != nil {
		return nil, err
	}
	plaintextDER, err := UnwrapEncryptedPKCS8(*root.PrivatePemEnc, passphrase)
	if err != nil {
		return nil, err
	}
	pemText := derToPKCS8PEM(plaintextDER)
	priv, err := be.ImportPrivate(KeyMaterial{
		Pem: PemKeyMaterial{PrivatePem: pemText, PublicPem: root.PublicPem},
	}, passphrase)
	if err != nil {
		return nil, err
	}
	canonical, err := attestationCanonical(s.Kid, s.Alg, s.PublicRaw, s.NotBefore, s.NotAfter)
	if err != nil {
		return nil, err
	}
	sig, err := be.Sign(priv, canonical)
	if err != nil {
		return nil, err
	}
	return &attestationOut{Canonical: canonical, Signature: sig, RootKid: root.Kid}, nil
}

// attestationCanonical emits the canonical JSON the root signs over:
//
//	{
//	  "kid": "<signing.kid>",
//	  "alg": "<signing.alg>",
//	  "pub": "<base64url(raw public)>",
//	  "not_before": "<iso>",
//	  "not_after": "<iso|null>"
//	}
//
// Byte-identical to the TS emitter so cross-language attestation verification
// works transparently.
func attestationCanonical(kid string, alg KeyAlg, publicRaw []byte, notBefore string, notAfter *string) ([]byte, error) {
	obj := map[string]any{
		"kid":        kid,
		"alg":        string(alg),
		"pub":        Base64urlEncode(publicRaw),
		"not_before": notBefore,
	}
	if notAfter != nil {
		obj["not_after"] = *notAfter
	} else {
		obj["not_after"] = nil
	}
	return Canonicalize(obj)
}

// privateMaterialToDER picks the PKCS#8 DER out of generated key material.
// All asymmetric backends return PEM; HMAC returns only raw bytes (and since
// HMAC secrets are symmetric, wrapping is still meaningful — we reuse the
// raw bytes as "plaintext DER" for storage purposes).
func privateMaterialToDER(pemMat PemKeyMaterial, rawMat RawKeyMaterial) ([]byte, error) {
	if pemMat.PrivatePem != "" {
		blk, _ := pem.Decode([]byte(pemMat.PrivatePem))
		if blk == nil {
			return nil, newError(CodeTokenMalformed,
				"privateMaterialToDER: failed to decode PEM", nil)
		}
		return blk.Bytes, nil
	}
	if len(rawMat.PrivateRaw) > 0 {
		cp := make([]byte, len(rawMat.PrivateRaw))
		copy(cp, rawMat.PrivateRaw)
		return cp, nil
	}
	return nil, nil
}

// derToPKCS8PEM re-wraps DER bytes as a "PRIVATE KEY" PEM.
func derToPKCS8PEM(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// extractPublicRawFromRecord recovers raw public bytes from a stored record.
// Per the TS sibling:
//
//   - Ed25519: 32-byte public is recoverable directly from SPKI
//   - RSA: raw == SPKI DER
//   - HMAC: never reaches here (symmetric; no attestation path)
func extractPublicRawFromRecord(rec *LicenseKey) ([]byte, error) {
	blk, _ := pem.Decode([]byte(rec.PublicPem))
	if blk == nil {
		return nil, newError(CodeTokenMalformed,
			"extractPublicRawFromRecord: invalid PEM", nil)
	}
	switch rec.Alg {
	case AlgEd25519:
		keyAny, err := x509.ParsePKIXPublicKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		pub, ok := keyAny.(stded.PublicKey)
		if !ok {
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("extractPublicRawFromRecord: expected ed25519.PublicKey, got %T", keyAny), nil)
		}
		cp := make([]byte, len(pub))
		copy(cp, pub)
		return cp, nil
	case AlgRSAPSS:
		// For RSA we emit the SPKI DER as the "raw" form, matching TS.
		keyAny, err := x509.ParsePKIXPublicKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		if _, ok := keyAny.(*stdrsa.PublicKey); !ok {
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("extractPublicRawFromRecord: expected *rsa.PublicKey, got %T", keyAny), nil)
		}
		cp := make([]byte, len(blk.Bytes))
		copy(cp, blk.Bytes)
		return cp, nil
	default:
		return nil, newError(CodeUnsupportedAlgorithm,
			fmt.Sprintf("extractPublicRawFromRecord: unsupported alg %s", rec.Alg),
			map[string]any{"alg": string(rec.Alg)})
	}
}
