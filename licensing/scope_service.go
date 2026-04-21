package licensing

// LicenseScope create + key-hierarchy rotation flows — Go port of
// typescript/packages/core/src/scope-service.ts.

import "fmt"

// CreateScopeInput is the caller-supplied shape for creating a scope.
type CreateScopeInput struct {
	Meta map[string]any
	Slug string
	Name string
}

// CreateScopeOptions carries optional settings.
type CreateScopeOptions struct {
	Actor string
}

// CreateScope creates a new scope with audit trail. Slug uniqueness is
// pre-checked inside the tx to produce a typed UniqueConstraintViolation,
// with the adapter's UNIQUE INDEX as a backstop for concurrent inserts.
func CreateScope(storage Storage, clock Clock, input CreateScopeInput, opts CreateScopeOptions) (*LicenseScope, error) {
	var scope *LicenseScope
	err := storage.WithTransaction(func(tx StorageTx) error {
		existing, err := tx.GetScopeBySlug(input.Slug)
		if err != nil {
			return err
		}
		if existing != nil {
			return newError(CodeUniqueConstraintViolation,
				"slug: "+input.Slug,
				map[string]any{"constraint": "scope.slug", "value": input.Slug})
		}

		scope, err = tx.CreateScope(LicenseScopeInput(input))
		if err != nil {
			return err
		}

		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		_, err = tx.AppendAudit(AuditLogInput{
			ScopeID: &scope.ID,
			Actor:   actor,
			Event:   "scope.created",
			NewState: map[string]any{
				"scope_id": scope.ID,
				"slug":     scope.Slug,
				"name":     scope.Name,
			},
			OccurredAt: clock.NowISO(),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return scope, nil
}

// ---------- Root + signing key flows ----------

// GenerateRootKeyInput is the caller-supplied shape for generating a root key.
type GenerateRootKeyInput struct {
	ScopeID    *string
	Alg        KeyAlg
	Passphrase string
	NotAfter   *string
	Kid        string // optional override
}

// KeyIssueOptions carries optional settings for key issuance.
type KeyIssueOptions struct {
	Actor string
}

// GenerateRootKey generates a fresh root key for a scope and writes a
// key.root.issued audit row. The passphrase is consumed in-frame and
// never persisted.
func GenerateRootKey(
	storage Storage, clock Clock,
	backends *AlgorithmRegistry,
	input GenerateRootKeyInput,
	opts KeyIssueOptions,
) (*LicenseKey, error) {
	var persisted *LicenseKey
	err := storage.WithTransaction(func(tx StorageTx) error {
		store := newStorageKeyStore(tx)
		hierarchy, err := NewKeyHierarchy(KeyHierarchyOptions{
			Store:    store,
			Registry: backends,
			Clock:    clock,
		})
		if err != nil {
			return err
		}
		genOpts := GenerateRootOptions{
			ScopeID:    input.ScopeID,
			Alg:        input.Alg,
			Passphrase: input.Passphrase,
			NotAfter:   input.NotAfter,
			Kid:        input.Kid,
		}
		root, err := hierarchy.GenerateRoot(genOpts)
		if err != nil {
			return err
		}
		persisted, err = tx.GetKeyByKid(root.Kid)
		if err != nil {
			return err
		}
		if persisted == nil {
			return fmt.Errorf("root key disappeared after issuance: %s", root.Kid)
		}
		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		_, err = tx.AppendAudit(AuditLogInput{
			ScopeID: input.ScopeID,
			Actor:   actor,
			Event:   "key.root.issued",
			NewState: map[string]any{
				"kid":       persisted.Kid,
				"alg":       string(persisted.Alg),
				"role":      string(persisted.Role),
				"not_after": persisted.NotAfter,
			},
			OccurredAt: clock.NowISO(),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return persisted, nil
}

// IssueInitialSigningKeyInput is the caller-supplied shape.
type IssueInitialSigningKeyInput struct {
	ScopeID           *string
	Alg               KeyAlg
	RootKid           string
	RootPassphrase    string
	SigningPassphrase string
	NotAfter          *string
	Kid               string
}

// IssueInitialSigningKey mints the first active signing key for a scope,
// attested by the given root. Writes a key.signing.issued audit row.
func IssueInitialSigningKey(
	storage Storage, clock Clock,
	backends *AlgorithmRegistry,
	input IssueInitialSigningKeyInput,
	opts KeyIssueOptions,
) (*LicenseKey, error) {
	var persisted *LicenseKey
	err := storage.WithTransaction(func(tx StorageTx) error {
		store := newStorageKeyStore(tx)
		hierarchy, err := NewKeyHierarchy(KeyHierarchyOptions{
			Store:    store,
			Registry: backends,
			Clock:    clock,
		})
		if err != nil {
			return err
		}
		signing, err := hierarchy.IssueSigning(IssueSigningOptions(input))
		if err != nil {
			return err
		}
		persisted, err = tx.GetKeyByKid(signing.Kid)
		if err != nil {
			return err
		}
		if persisted == nil {
			return fmt.Errorf("signing key disappeared after issuance: %s", signing.Kid)
		}
		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		_, err = tx.AppendAudit(AuditLogInput{
			ScopeID: input.ScopeID,
			Actor:   actor,
			Event:   "key.signing.issued",
			NewState: map[string]any{
				"kid":       persisted.Kid,
				"alg":       string(persisted.Alg),
				"role":      string(persisted.Role),
				"root_kid":  input.RootKid,
				"not_after": persisted.NotAfter,
			},
			OccurredAt: clock.NowISO(),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return persisted, nil
}

// RotateSigningKeyInput is the caller-supplied shape.
type RotateSigningKeyInput struct {
	ScopeID           *string
	Alg               KeyAlg
	RootKid           string
	RootPassphrase    string
	SigningPassphrase string
	RetireOutgoingAt  *string
	Kid               string
}

// RotateSigningKeyOptions carries optional settings.
type RotateSigningKeyOptions struct {
	Actor string
}

// RotateSigningKeyResult holds the outgoing and incoming keys.
type RotateSigningKeyResult struct {
	Outgoing *LicenseKey
	Incoming *LicenseKey
}

// RotateSigningKey rotates the active signing key. The outgoing key is
// demoted to retiring. Writes a key.rotated audit row.
func RotateSigningKey(
	storage Storage, clock Clock,
	backends *AlgorithmRegistry,
	input RotateSigningKeyInput,
	opts RotateSigningKeyOptions,
) (*RotateSigningKeyResult, error) {
	var rotResult *RotateSigningKeyResult
	err := storage.WithTransaction(func(tx StorageTx) error {
		store := newStorageKeyStore(tx)
		hierarchy, err := NewKeyHierarchy(KeyHierarchyOptions{
			Store:    store,
			Registry: backends,
			Clock:    clock,
		})
		if err != nil {
			return err
		}
		rotOpts := RotateSigningOptions{
			ScopeID:           input.ScopeID,
			Alg:               input.Alg,
			RootKid:           input.RootKid,
			RootPassphrase:    input.RootPassphrase,
			SigningPassphrase: input.SigningPassphrase,
			RetireOutgoingAt:  input.RetireOutgoingAt,
			Kid:               input.Kid,
		}
		result, err := hierarchy.RotateSigning(rotOpts)
		if err != nil {
			return err
		}
		rotResult = &RotateSigningKeyResult{
			Outgoing: &result.Outgoing,
			Incoming: &result.Incoming,
		}
		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		_, err = tx.AppendAudit(AuditLogInput{
			ScopeID: input.ScopeID,
			Actor:   actor,
			Event:   "key.rotated",
			PriorState: map[string]any{
				"kid":   result.Outgoing.Kid,
				"state": "active",
			},
			NewState: map[string]any{
				"outgoing_kid":   result.Outgoing.Kid,
				"outgoing_state": string(result.Outgoing.State),
				"incoming_kid":   result.Incoming.Kid,
				"incoming_state": string(result.Incoming.State),
				"alg":            string(input.Alg),
			},
			OccurredAt: clock.NowISO(),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return rotResult, nil
}

// ---------- Storage-backed KeyStore adapter ----------

// storageKeyStore adapts StorageTx into the KeyStore interface.
// Translates hierarchy-assigned IDs to adapter-assigned IDs via an
// internal map populated during Put calls.
type storageKeyStore struct {
	tx    StorageTx
	idMap map[string]string // hierarchy id → adapter id
}

func newStorageKeyStore(tx StorageTx) *storageKeyStore {
	return &storageKeyStore{tx: tx, idMap: make(map[string]string)}
}

func (s *storageKeyStore) resolve(id string) string {
	if mapped, ok := s.idMap[id]; ok {
		return mapped
	}
	return id
}

// Put persists a LicenseKey through the transaction and remembers the
// hierarchy→adapter ID mapping so later Get/Update calls can resolve.
func (s *storageKeyStore) Put(record LicenseKey) error {
	existing, err := s.tx.GetKeyByKid(record.Kid)
	if err != nil {
		return err
	}
	if existing != nil {
		return newError(CodeUniqueConstraintViolation,
			"kid: "+record.Kid,
			map[string]any{"constraint": "kid", "value": record.Kid})
	}
	persisted, err := s.tx.CreateKey(LicenseKeyInput{
		ScopeID:       record.ScopeID,
		Kid:           record.Kid,
		Alg:           record.Alg,
		Role:          record.Role,
		State:         record.State,
		PublicPem:     record.PublicPem,
		PrivatePemEnc: record.PrivatePemEnc,
		RotatedFrom:   record.RotatedFrom,
		RotatedAt:     record.RotatedAt,
		NotBefore:     record.NotBefore,
		NotAfter:      record.NotAfter,
		Meta:          record.Meta,
	})
	if err != nil {
		return err
	}
	s.idMap[record.ID] = persisted.ID
	return nil
}

// Get fetches the record.
func (s *storageKeyStore) Get(id string) (*LicenseKey, error) {
	return s.tx.GetKey(s.resolve(id))
}

// FindByKid finds by kid.
func (s *storageKeyStore) FindByKid(kid string) (*LicenseKey, error) {
	return s.tx.GetKeyByKid(kid)
}

// List lists the record.
func (s *storageKeyStore) List(filter KeyStoreFilter) ([]LicenseKey, error) {
	var out []LicenseKey
	lkf := LicenseKeyFilter{
		ScopeID:    filter.ScopeID,
		ScopeIDSet: filter.ScopeIDSet,
		Role:       filter.Role,
		State:      filter.State,
		Alg:        filter.Alg,
	}
	cursor := ""
	for {
		page, err := s.tx.ListKeys(lkf, PageRequest{Limit: 500, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		out = append(out, page.Items...)
		if page.Cursor == "" {
			return out, nil
		}
		cursor = page.Cursor
	}
}

// Update updates the record.
func (s *storageKeyStore) Update(id string, next LicenseKey) error {
	realID := s.resolve(id)
	existing, err := s.tx.GetKey(realID)
	if err != nil {
		return err
	}
	if existing == nil {
		return newError(CodeTokenMalformed,
			fmt.Sprintf("key not found: %s", realID), nil)
	}
	_, err = s.tx.UpdateKey(realID, LicenseKeyPatch{
		State:       &next.State,
		RotatedFrom: OptString{Set: true, Value: next.RotatedFrom},
		RotatedAt:   OptString{Set: true, Value: next.RotatedAt},
		NotAfter:    OptString{Set: true, Value: next.NotAfter},
		Meta:        OptJSON{Set: true, Value: next.Meta},
	})
	return err
}
