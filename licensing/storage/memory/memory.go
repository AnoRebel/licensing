// Package memory provides an in-process Storage implementation backed by
// Go maps. Mirrors @licensing/storage-memory.
//
// State is held in six tables keyed by id. Primary-key lookups are O(1);
// natural-key / filter scans are O(n) — acceptable for a test/dev
// adapter, not production.
//
// Transactional model
//
//	WithTransaction(fn) clones every table up front. Writes inside fn
//	land on the cloned tables; the live tables are untouched until fn
//	returns nil, at which point the clone is swapped in atomically via a
//	single field assignment. Errors returned from fn drop the clone and
//	leave live state unchanged.
//
// Nested transactions are not supported — savepoints in memory would
// drift from how Postgres/SQLite will behave (they'll error on nested
// BEGIN too). Calling WithTransaction on
// the StorageTx handle (memoryTx) returns a nested-tx error immediately,
// without blocking on the mutex — the caller's goroutine is the one
// holding it, so a lock attempt would deadlock.
//
// Concurrency
//
//	A single sync.Mutex on *Storage serializes every method. The tx
//	handle passed to fn (a *memoryTx) does NOT take the mutex again: it
//	inherits the mutex already held by WithTransaction. This is safe
//	because only one goroutine can hold the mutex at a time, so only one
//	transaction runs at a time; the tx's writes land on a snapshot the
//	outer mutex-holder then commits or discards.
//
// AuditLog immutability
//
//	The surface exposes AppendAudit / GetAudit / ListAudit only. There is
//	no code path to mutate an audit row — immutability by construction.
package memory

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"sort"
	"sync"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ---------- Internal state ----------

// state is the adapter's data plane: six tables keyed by id. Operations
// are defined as methods on *state so the exact same CRUD logic can be
// reused by *Storage (locked, non-tx path) and *memoryTx (unlocked,
// tx-body path). No field on *state is concurrency-safe on its own —
// synchronization lives one level up on *Storage.
type state struct {
	licenses  map[string]lic.License
	scopes    map[string]lic.LicenseScope
	templates map[string]lic.LicenseTemplate
	usages    map[string]lic.LicenseUsage
	keys      map[string]lic.LicenseKey
	audit     map[string]lic.AuditLogEntry
}

func newState() *state {
	return &state{
		licenses:  map[string]lic.License{},
		scopes:    map[string]lic.LicenseScope{},
		templates: map[string]lic.LicenseTemplate{},
		usages:    map[string]lic.LicenseUsage{},
		keys:      map[string]lic.LicenseKey{},
		audit:     map[string]lic.AuditLogEntry{},
	}
}

// clone returns a shallow copy. Row structs are value-typed so sharing
// references across the clone and the live state is safe — mutation
// goes through the map by reassignment, never in-place. The embedded
// meta/entitlements maps are shared by reference; every Update* method
// builds a fresh row and replaces the entry, never editing an embedded
// map in place, which preserves that invariant.
func (s *state) clone() *state {
	out := &state{
		licenses:  make(map[string]lic.License, len(s.licenses)),
		scopes:    make(map[string]lic.LicenseScope, len(s.scopes)),
		templates: make(map[string]lic.LicenseTemplate, len(s.templates)),
		usages:    make(map[string]lic.LicenseUsage, len(s.usages)),
		keys:      make(map[string]lic.LicenseKey, len(s.keys)),
		audit:     make(map[string]lic.AuditLogEntry, len(s.audit)),
	}
	maps.Copy(out.licenses, s.licenses)
	maps.Copy(out.scopes, s.scopes)
	maps.Copy(out.templates, s.templates)
	maps.Copy(out.usages, s.usages)
	maps.Copy(out.keys, s.keys)
	maps.Copy(out.audit, s.audit)
	return out
}

// ---------- Storage struct ----------

// Options configures a Storage.
type Options struct {
	// Clock is used for `created_at` / `updated_at`. Defaults to
	// licensing.SystemClock if nil.
	Clock lic.Clock
}

// Storage is the in-memory implementation of licensing.Storage.
type Storage struct {
	clock lic.Clock
	s     *state
	mu    sync.Mutex
	inTx  bool
}

// Compile-time assertions.
var (
	_ lic.Storage   = (*Storage)(nil)
	_ lic.StorageTx = (*memoryTx)(nil)
)

// New builds an empty in-memory Storage.
func New(opts Options) *Storage {
	var clk lic.Clock = lic.SystemClock{}
	if opts.Clock != nil {
		clk = opts.Clock
	}
	return &Storage{
		clock: clk,
		s:     newState(),
	}
}

// ---------- Public Storage surface (locked) ----------

// CreateLicense creates license.
func (s *Storage) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return createLicense(s.s, s.clock, in)
}

// GetLicense fetches license.
func (s *Storage) GetLicense(id string) (*lic.License, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getLicense(s.s, id)
}

// GetLicenseByKey fetches license by key.
func (s *Storage) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getLicenseByKey(s.s, licenseKey)
}

// ListLicenses lists licenses.
func (s *Storage) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listLicenses(s.s, filter, page)
}

// UpdateLicense updates license.
func (s *Storage) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return updateLicense(s.s, s.clock, id, patch)
}

// DeleteLicense deletes license.
func (s *Storage) DeleteLicense(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return deleteLicense(s.s, id)
}

// CreateScope creates scope.
func (s *Storage) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return createScope(s.s, s.clock, in)
}

// GetScope fetches scope.
func (s *Storage) GetScope(id string) (*lic.LicenseScope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getScope(s.s, id)
}

// GetScopeBySlug fetches scope by slug.
func (s *Storage) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getScopeBySlug(s.s, slug)
}

// ListScopes lists scopes.
func (s *Storage) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listScopes(s.s, filter, page)
}

// UpdateScope updates scope.
func (s *Storage) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return updateScope(s.s, s.clock, id, patch)
}

// DeleteScope deletes scope.
func (s *Storage) DeleteScope(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return deleteScope(s.s, id)
}

// CreateTemplate creates template.
func (s *Storage) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return createTemplate(s.s, s.clock, in)
}

// GetTemplate fetches template.
func (s *Storage) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getTemplate(s.s, id)
}

// ListTemplates lists templates.
func (s *Storage) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listTemplates(s.s, filter, page)
}

// UpdateTemplate updates template.
func (s *Storage) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return updateTemplate(s.s, s.clock, id, patch)
}

// DeleteTemplate deletes template.
func (s *Storage) DeleteTemplate(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return deleteTemplate(s.s, id)
}

// CreateUsage creates usage.
func (s *Storage) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return createUsage(s.s, s.clock, in)
}

// GetUsage fetches usage.
func (s *Storage) GetUsage(id string) (*lic.LicenseUsage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getUsage(s.s, id)
}

// ListUsages lists usages.
func (s *Storage) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listUsages(s.s, filter, page)
}

// UpdateUsage updates usage.
func (s *Storage) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return updateUsage(s.s, s.clock, id, patch)
}

// CreateKey creates key.
func (s *Storage) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return createKey(s.s, s.clock, in)
}

// GetKey fetches key.
func (s *Storage) GetKey(id string) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getKey(s.s, id)
}

// GetKeyByKid fetches key by kid.
func (s *Storage) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getKeyByKid(s.s, kid)
}

// ListKeys lists keys.
func (s *Storage) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listKeys(s.s, filter, page)
}

// UpdateKey updates key.
func (s *Storage) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return updateKey(s.s, s.clock, id, patch)
}

// AppendAudit appends audit.
func (s *Storage) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return appendAudit(s.s, in)
}

// GetAudit fetches audit.
func (s *Storage) GetAudit(id string) (*lic.AuditLogEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return getAudit(s.s, id)
}

// ListAudit lists audit.
func (s *Storage) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return listAudit(s.s, filter, page)
}

// WithTransaction runs fn atomically. On nil return, the cloned
// snapshot is swapped in as the live state. On any error return, the
// clone is discarded and the live state is unchanged.
//
// The mutex is held for the entire duration of fn — concurrent callers
// block until the tx completes. The tx handle passed to fn (*memoryTx)
// does NOT take the mutex again; see type-level comment for the
// rationale.
//
// Nested transactions are rejected: the *memoryTx handle's own
// WithTransaction returns an error without trying to re-acquire the
// mutex. That avoids the deadlock that naive re-entry would produce.
func (s *Storage) WithTransaction(fn func(tx lic.StorageTx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inTx {
		// Defense in depth — should be unreachable because only the
		// goroutine holding mu can observe s.inTx as true, and that
		// goroutine is in fn already.
		return errors.New("memory storage: nested transactions are not supported")
	}
	snap := s.s.clone()
	tx := &memoryTx{state: snap, clock: s.clock}
	s.inTx = true
	defer func() { s.inTx = false }()
	if err := fn(tx); err != nil {
		// Rollback: drop snap. Live s.s is unchanged because we never
		// wrote to it.
		return err
	}
	// Commit: atomically swap the snapshot in as the live state.
	s.s = snap
	return nil
}

// DescribeSchema returns the canonical schema description; the in-memory
// adapter has no DDL so it just returns the canonical definition verbatim.
func (s *Storage) DescribeSchema() lic.SchemaDescription {
	return lic.CanonicalSchema()
}

// Close is a no-op for the in-memory adapter.
func (s *Storage) Close() error {
	return nil
}

// ---------- Transaction handle (no mutex; inherits the outer lock) ----------

// memoryTx is the StorageTx handed to fn inside WithTransaction. It
// writes to a cloned state without acquiring the outer Storage's mutex
// — the mutex is already held by WithTransaction for the duration of
// fn. A nested WithTransaction on memoryTx returns an error instead of
// attempting to re-lock (which would deadlock the same goroutine).
type memoryTx struct {
	state *state
	clock lic.Clock
}

// CreateLicense creates license.
func (t *memoryTx) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	return createLicense(t.state, t.clock, in)
}

// GetLicense fetches license.
func (t *memoryTx) GetLicense(id string) (*lic.License, error) {
	return getLicense(t.state, id)
}

// GetLicenseByKey fetches license by key.
func (t *memoryTx) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	return getLicenseByKey(t.state, licenseKey)
}

// ListLicenses lists licenses.
func (t *memoryTx) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	return listLicenses(t.state, filter, page)
}

// UpdateLicense updates license.
func (t *memoryTx) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	return updateLicense(t.state, t.clock, id, patch)
}

// DeleteLicense deletes license.
func (t *memoryTx) DeleteLicense(id string) error {
	return deleteLicense(t.state, id)
}

// CreateScope creates scope.
func (t *memoryTx) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	return createScope(t.state, t.clock, in)
}

// GetScope fetches scope.
func (t *memoryTx) GetScope(id string) (*lic.LicenseScope, error) { return getScope(t.state, id) }

// GetScopeBySlug fetches scope by slug.
func (t *memoryTx) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	return getScopeBySlug(t.state, slug)
}

// ListScopes lists scopes.
func (t *memoryTx) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	return listScopes(t.state, filter, page)
}

// UpdateScope updates scope.
func (t *memoryTx) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	return updateScope(t.state, t.clock, id, patch)
}

// DeleteScope deletes scope.
func (t *memoryTx) DeleteScope(id string) error {
	return deleteScope(t.state, id)
}

// CreateTemplate creates template.
func (t *memoryTx) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	return createTemplate(t.state, t.clock, in)
}

// GetTemplate fetches template.
func (t *memoryTx) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	return getTemplate(t.state, id)
}

// ListTemplates lists templates.
func (t *memoryTx) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	return listTemplates(t.state, filter, page)
}

// UpdateTemplate updates template.
func (t *memoryTx) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	return updateTemplate(t.state, t.clock, id, patch)
}

// DeleteTemplate deletes template.
func (t *memoryTx) DeleteTemplate(id string) error {
	return deleteTemplate(t.state, id)
}

// CreateUsage creates usage.
func (t *memoryTx) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	return createUsage(t.state, t.clock, in)
}

// GetUsage fetches usage.
func (t *memoryTx) GetUsage(id string) (*lic.LicenseUsage, error) { return getUsage(t.state, id) }

// ListUsages lists usages.
func (t *memoryTx) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	return listUsages(t.state, filter, page)
}

// UpdateUsage updates usage.
func (t *memoryTx) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	return updateUsage(t.state, t.clock, id, patch)
}

// CreateKey creates key.
func (t *memoryTx) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	return createKey(t.state, t.clock, in)
}

// GetKey fetches key.
func (t *memoryTx) GetKey(id string) (*lic.LicenseKey, error) { return getKey(t.state, id) }

// GetKeyByKid fetches key by kid.
func (t *memoryTx) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	return getKeyByKid(t.state, kid)
}

// ListKeys lists keys.
func (t *memoryTx) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	return listKeys(t.state, filter, page)
}

// UpdateKey updates key.
func (t *memoryTx) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	return updateKey(t.state, t.clock, id, patch)
}

// AppendAudit appends audit.
func (t *memoryTx) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	return appendAudit(t.state, in)
}

// GetAudit fetches audit.
func (t *memoryTx) GetAudit(id string) (*lic.AuditLogEntry, error) { return getAudit(t.state, id) }

// ListAudit lists audit.
func (t *memoryTx) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	return listAudit(t.state, filter, page)
}

// ---------- Core CRUD, operating on a *state directly ----------
//
// These functions are shared between *Storage (locked entry) and
// *memoryTx (no lock, already inside a tx). They take the state,
// clock, and the operation's inputs — no adapter-level plumbing.

// Licenses --------------------------------------------------------------

func createLicense(s *state, clk lic.Clock, in lic.LicenseInput) (*lic.License, error) {
	for _, row := range s.licenses {
		if row.LicenseKey == in.LicenseKey {
			return nil, lic.NewError(lic.CodeLicenseKeyConflict,
				fmt.Sprintf("license_key already exists: %s", in.LicenseKey),
				map[string]any{"license_key": in.LicenseKey})
		}
		if row.LicensableType == in.LicensableType &&
			row.LicensableID == in.LicensableID &&
			ptrEq(row.ScopeID, in.ScopeID) {
			return nil, uniqueViolation("licensable_scope",
				fmt.Sprintf("%s:%s:%s", in.LicensableType, in.LicensableID, ptrOrNullStr(in.ScopeID)))
		}
	}
	now := clk.NowISO()
	row := lic.License{
		ID:             lic.NewUUIDv7(),
		ScopeID:        in.ScopeID,
		TemplateID:     in.TemplateID,
		LicensableType: in.LicensableType,
		LicensableID:   in.LicensableID,
		LicenseKey:     in.LicenseKey,
		Status:         in.Status,
		MaxUsages:      in.MaxUsages,
		ActivatedAt:    in.ActivatedAt,
		ExpiresAt:      in.ExpiresAt,
		GraceUntil:     in.GraceUntil,
		Meta:           orEmptyMap(in.Meta),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	s.licenses[row.ID] = row
	return &row, nil
}

func getLicense(s *state, id string) (*lic.License, error) {
	row, ok := s.licenses[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func getLicenseByKey(s *state, licenseKey string) (*lic.License, error) {
	for _, row := range s.licenses {
		if row.LicenseKey == licenseKey {
			r := row
			return &r, nil
		}
	}
	return nil, nil
}

func listLicenses(s *state, filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	rows := make([]lic.License, 0, len(s.licenses))
	for _, r := range s.licenses {
		if filter.ScopeIDSet && !ptrEq(r.ScopeID, filter.ScopeID) {
			continue
		}
		if len(filter.Status) > 0 && !slices.Contains(filter.Status, r.Status) {
			continue
		}
		if filter.LicensableType != nil && r.LicensableType != *filter.LicensableType {
			continue
		}
		if filter.LicensableID != nil && r.LicensableID != *filter.LicensableID {
			continue
		}
		if filter.TemplateIDSet && !ptrEq(r.TemplateID, filter.TemplateID) {
			continue
		}
		rows = append(rows, r)
	}
	return paginate(rows, page, func(r lic.License) (string, string) { return r.CreatedAt, r.ID }), nil
}

func updateLicense(s *state, clk lic.Clock, id string, patch lic.LicensePatch) (*lic.License, error) {
	cur, ok := s.licenses[id]
	if !ok {
		return nil, lic.NewError(lic.CodeLicenseNotFound,
			fmt.Sprintf("license not found: %s", id),
			map[string]any{"id": id})
	}
	if patch.Status != nil {
		cur.Status = *patch.Status
	}
	if patch.MaxUsages != nil {
		cur.MaxUsages = *patch.MaxUsages
	}
	if patch.ActivatedAt.Set {
		cur.ActivatedAt = patch.ActivatedAt.Value
	}
	if patch.ExpiresAt.Set {
		cur.ExpiresAt = patch.ExpiresAt.Value
	}
	if patch.GraceUntil.Set {
		cur.GraceUntil = patch.GraceUntil.Value
	}
	if patch.Meta.Set {
		cur.Meta = orEmptyMap(patch.Meta.Value)
	}
	if patch.ScopeID.Set {
		cur.ScopeID = patch.ScopeID.Value
	}
	if patch.TemplateID.Set {
		cur.TemplateID = patch.TemplateID.Value
	}
	cur.UpdatedAt = clk.NowISO()
	s.licenses[id] = cur
	return &cur, nil
}

func deleteLicense(s *state, id string) error {
	if _, ok := s.licenses[id]; !ok {
		return lic.NewError(lic.CodeLicenseNotFound,
			fmt.Sprintf("license not found: %s", id),
			map[string]any{"id": id})
	}
	for _, u := range s.usages {
		if u.LicenseID == id && u.Status == lic.UsageStatusActive {
			return uniqueViolation("license_id", id+" (has active usages)")
		}
	}
	delete(s.licenses, id)
	return nil
}

// LicenseScopes --------------------------------------------------------

func createScope(s *state, clk lic.Clock, in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	for _, row := range s.scopes {
		if row.Slug == in.Slug {
			return nil, uniqueViolation("slug", in.Slug)
		}
	}
	now := clk.NowISO()
	row := lic.LicenseScope{
		ID:        lic.NewUUIDv7(),
		Slug:      in.Slug,
		Name:      in.Name,
		Meta:      orEmptyMap(in.Meta),
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.scopes[row.ID] = row
	return &row, nil
}

func getScope(s *state, id string) (*lic.LicenseScope, error) {
	row, ok := s.scopes[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func getScopeBySlug(s *state, slug string) (*lic.LicenseScope, error) {
	for _, row := range s.scopes {
		if row.Slug == slug {
			r := row
			return &r, nil
		}
	}
	return nil, nil
}

func listScopes(s *state, filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	rows := make([]lic.LicenseScope, 0, len(s.scopes))
	for _, r := range s.scopes {
		if filter.Slug != nil && r.Slug != *filter.Slug {
			continue
		}
		rows = append(rows, r)
	}
	return paginate(rows, page, func(r lic.LicenseScope) (string, string) { return r.CreatedAt, r.ID }), nil
}

func updateScope(s *state, clk lic.Clock, id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	cur, ok := s.scopes[id]
	if !ok {
		return nil, uniqueViolation("pk", id)
	}
	if patch.Name != nil {
		cur.Name = *patch.Name
	}
	if patch.Meta.Set {
		cur.Meta = orEmptyMap(patch.Meta.Value)
	}
	cur.UpdatedAt = clk.NowISO()
	s.scopes[id] = cur
	return &cur, nil
}

func deleteScope(s *state, id string) error {
	if _, ok := s.scopes[id]; !ok {
		return lic.NewError(lic.CodeLicenseNotFound,
			fmt.Sprintf("scope not found: %s", id),
			map[string]any{"id": id})
	}
	for _, l := range s.licenses {
		if l.ScopeID != nil && *l.ScopeID == id {
			return uniqueViolation("scope_id", id+" (referenced by license)")
		}
	}
	for _, t := range s.templates {
		if t.ScopeID != nil && *t.ScopeID == id {
			return uniqueViolation("scope_id", id+" (referenced by template)")
		}
	}
	delete(s.scopes, id)
	return nil
}

// LicenseTemplates -----------------------------------------------------

func createTemplate(s *state, clk lic.Clock, in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	for _, row := range s.templates {
		if ptrEq(row.ScopeID, in.ScopeID) && row.Name == in.Name {
			return nil, uniqueViolation("scope_name",
				fmt.Sprintf("%s:%s", ptrOrNullStr(in.ScopeID), in.Name))
		}
	}
	now := clk.NowISO()
	row := lic.LicenseTemplate{
		ID:                  lic.NewUUIDv7(),
		ScopeID:             in.ScopeID,
		Name:                in.Name,
		MaxUsages:           in.MaxUsages,
		TrialDurationSec:    in.TrialDurationSec,
		GraceDurationSec:    in.GraceDurationSec,
		ForceOnlineAfterSec: in.ForceOnlineAfterSec,
		Entitlements:        orEmptyMap(in.Entitlements),
		Meta:                orEmptyMap(in.Meta),
		CreatedAt:           now,
		UpdatedAt:           now,
	}
	s.templates[row.ID] = row
	return &row, nil
}

func getTemplate(s *state, id string) (*lic.LicenseTemplate, error) {
	row, ok := s.templates[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func listTemplates(s *state, filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	rows := make([]lic.LicenseTemplate, 0, len(s.templates))
	for _, r := range s.templates {
		if filter.ScopeIDSet && !ptrEq(r.ScopeID, filter.ScopeID) {
			continue
		}
		if filter.Name != nil && r.Name != *filter.Name {
			continue
		}
		rows = append(rows, r)
	}
	return paginate(rows, page, func(r lic.LicenseTemplate) (string, string) { return r.CreatedAt, r.ID }), nil
}

func updateTemplate(s *state, clk lic.Clock, id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	cur, ok := s.templates[id]
	if !ok {
		return nil, uniqueViolation("pk", id)
	}
	if patch.Name != nil {
		cur.Name = *patch.Name
	}
	if patch.MaxUsages != nil {
		cur.MaxUsages = *patch.MaxUsages
	}
	if patch.TrialDurationSec != nil {
		cur.TrialDurationSec = *patch.TrialDurationSec
	}
	if patch.GraceDurationSec != nil {
		cur.GraceDurationSec = *patch.GraceDurationSec
	}
	if patch.ForceOnlineAfterSec.Set {
		cur.ForceOnlineAfterSec = patch.ForceOnlineAfterSec.Value
	}
	if patch.Entitlements.Set {
		cur.Entitlements = orEmptyMap(patch.Entitlements.Value)
	}
	if patch.Meta.Set {
		cur.Meta = orEmptyMap(patch.Meta.Value)
	}
	cur.UpdatedAt = clk.NowISO()
	s.templates[id] = cur
	return &cur, nil
}

func deleteTemplate(s *state, id string) error {
	if _, ok := s.templates[id]; !ok {
		return lic.NewError(lic.CodeLicenseNotFound,
			fmt.Sprintf("template not found: %s", id),
			map[string]any{"id": id})
	}
	for _, l := range s.licenses {
		if l.TemplateID != nil && *l.TemplateID == id {
			return uniqueViolation("template_id", id+" (referenced by license)")
		}
	}
	delete(s.templates, id)
	return nil
}

// LicenseUsages --------------------------------------------------------

func createUsage(s *state, clk lic.Clock, in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	// Partial unique: (license_id, fingerprint) WHERE status='active'.
	// A fingerprint may re-register after revocation; it just cannot be
	// active twice simultaneously for the same license.
	if in.Status == lic.UsageStatusActive {
		for _, row := range s.usages {
			if row.LicenseID == in.LicenseID &&
				row.Fingerprint == in.Fingerprint &&
				row.Status == lic.UsageStatusActive {
				return nil, uniqueViolation("license_fingerprint_active",
					fmt.Sprintf("%s:%s", in.LicenseID, in.Fingerprint))
			}
		}
	}
	now := clk.NowISO()
	row := lic.LicenseUsage{
		ID:           lic.NewUUIDv7(),
		LicenseID:    in.LicenseID,
		Fingerprint:  in.Fingerprint,
		Status:       in.Status,
		RegisteredAt: in.RegisteredAt,
		RevokedAt:    in.RevokedAt,
		ClientMeta:   orEmptyMap(in.ClientMeta),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	s.usages[row.ID] = row
	return &row, nil
}

func getUsage(s *state, id string) (*lic.LicenseUsage, error) {
	row, ok := s.usages[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func listUsages(s *state, filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	rows := make([]lic.LicenseUsage, 0, len(s.usages))
	for _, r := range s.usages {
		if filter.LicenseID != nil && r.LicenseID != *filter.LicenseID {
			continue
		}
		if filter.Fingerprint != nil && r.Fingerprint != *filter.Fingerprint {
			continue
		}
		if len(filter.Status) > 0 && !slices.Contains(filter.Status, r.Status) {
			continue
		}
		rows = append(rows, r)
	}
	return paginate(rows, page, func(r lic.LicenseUsage) (string, string) { return r.CreatedAt, r.ID }), nil
}

func updateUsage(s *state, clk lic.Clock, id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	cur, ok := s.usages[id]
	if !ok {
		return nil, uniqueViolation("pk", id)
	}
	// Re-enforce partial-unique if transitioning TO active.
	if patch.Status != nil && *patch.Status == lic.UsageStatusActive && cur.Status != lic.UsageStatusActive {
		for _, row := range s.usages {
			if row.ID != id &&
				row.LicenseID == cur.LicenseID &&
				row.Fingerprint == cur.Fingerprint &&
				row.Status == lic.UsageStatusActive {
				return nil, uniqueViolation("license_fingerprint_active",
					fmt.Sprintf("%s:%s", cur.LicenseID, cur.Fingerprint))
			}
		}
	}
	if patch.Status != nil {
		cur.Status = *patch.Status
	}
	if patch.RevokedAt.Set {
		cur.RevokedAt = patch.RevokedAt.Value
	}
	if patch.ClientMeta.Set {
		cur.ClientMeta = orEmptyMap(patch.ClientMeta.Value)
	}
	cur.UpdatedAt = clk.NowISO()
	s.usages[id] = cur
	return &cur, nil
}

// LicenseKeys ----------------------------------------------------------

func createKey(s *state, clk lic.Clock, in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	// Unique: kid (global).
	for _, row := range s.keys {
		if row.Kid == in.Kid {
			return nil, uniqueViolation("kid", in.Kid)
		}
	}
	// Partial unique: (scope_id, role='signing', state='active').
	if in.Role == lic.RoleSigning && in.State == lic.StateActive {
		for _, row := range s.keys {
			if row.Role == lic.RoleSigning && row.State == lic.StateActive && ptrEq(row.ScopeID, in.ScopeID) {
				return nil, uniqueViolation("scope_active_signing",
					ptrOrNullStr(in.ScopeID))
			}
		}
	}
	now := clk.NowISO()
	row := lic.LicenseKey{
		ID:            lic.NewUUIDv7(),
		ScopeID:       in.ScopeID,
		Kid:           in.Kid,
		Alg:           in.Alg,
		Role:          in.Role,
		State:         in.State,
		PublicPem:     in.PublicPem,
		PrivatePemEnc: in.PrivatePemEnc,
		RotatedFrom:   in.RotatedFrom,
		RotatedAt:     in.RotatedAt,
		NotBefore:     in.NotBefore,
		NotAfter:      in.NotAfter,
		Meta:          orEmptyMap(in.Meta),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	s.keys[row.ID] = row
	return &row, nil
}

func getKey(s *state, id string) (*lic.LicenseKey, error) {
	row, ok := s.keys[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func getKeyByKid(s *state, kid string) (*lic.LicenseKey, error) {
	for _, row := range s.keys {
		if row.Kid == kid {
			r := row
			return &r, nil
		}
	}
	return nil, nil
}

func listKeys(s *state, filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	rows := make([]lic.LicenseKey, 0, len(s.keys))
	for _, r := range s.keys {
		if filter.ScopeIDSet && !ptrEq(r.ScopeID, filter.ScopeID) {
			continue
		}
		if filter.Kid != nil && r.Kid != *filter.Kid {
			continue
		}
		if filter.Alg != nil && r.Alg != *filter.Alg {
			continue
		}
		if filter.Role != nil && r.Role != *filter.Role {
			continue
		}
		if filter.State != nil && r.State != *filter.State {
			continue
		}
		rows = append(rows, r)
	}
	return paginate(rows, page, func(r lic.LicenseKey) (string, string) { return r.CreatedAt, r.ID }), nil
}

func updateKey(s *state, clk lic.Clock, id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	cur, ok := s.keys[id]
	if !ok {
		return nil, uniqueViolation("pk", id)
	}
	// Re-enforce partial-unique when activating a signing key.
	if patch.State != nil && *patch.State == lic.StateActive && cur.State != lic.StateActive && cur.Role == lic.RoleSigning {
		for _, row := range s.keys {
			if row.ID != id &&
				row.Role == lic.RoleSigning &&
				row.State == lic.StateActive &&
				ptrEq(row.ScopeID, cur.ScopeID) {
				return nil, uniqueViolation("scope_active_signing",
					ptrOrNullStr(cur.ScopeID))
			}
		}
	}
	if patch.State != nil {
		cur.State = *patch.State
	}
	if patch.RotatedFrom.Set {
		cur.RotatedFrom = patch.RotatedFrom.Value
	}
	if patch.RotatedAt.Set {
		cur.RotatedAt = patch.RotatedAt.Value
	}
	if patch.NotAfter.Set {
		cur.NotAfter = patch.NotAfter.Value
	}
	if patch.Meta.Set {
		cur.Meta = orEmptyMap(patch.Meta.Value)
	}
	cur.UpdatedAt = clk.NowISO()
	s.keys[id] = cur
	return &cur, nil
}

// AuditLog -------------------------------------------------------------

func appendAudit(s *state, in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	row := lic.AuditLogEntry{
		ID:         lic.NewUUIDv7(),
		LicenseID:  in.LicenseID,
		ScopeID:    in.ScopeID,
		Actor:      in.Actor,
		Event:      in.Event,
		PriorState: in.PriorState,
		NewState:   in.NewState,
		OccurredAt: in.OccurredAt,
	}
	s.audit[row.ID] = row
	return &row, nil
}

func getAudit(s *state, id string) (*lic.AuditLogEntry, error) {
	row, ok := s.audit[id]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func listAudit(s *state, filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	rows := make([]lic.AuditLogEntry, 0, len(s.audit))
	for _, r := range s.audit {
		if filter.LicenseIDSet && !ptrEq(r.LicenseID, filter.LicenseID) {
			continue
		}
		if filter.ScopeIDSet && !ptrEq(r.ScopeID, filter.ScopeID) {
			continue
		}
		if filter.Event != nil && r.Event != *filter.Event {
			continue
		}
		rows = append(rows, r)
	}
	// AuditLog orders by occurred_at DESC, id DESC — no created_at on
	// this entity. Pass occurred_at through the key extractor so
	// paginate sorts correctly.
	return paginate(rows, page, func(r lic.AuditLogEntry) (string, string) { return r.OccurredAt, r.ID }), nil
}

// ---------- Internal utility helpers ----------

// uniqueViolation builds a CodeUniqueConstraintViolation error with the
// constraint name and key. Callers attach adapter-local context via the
// second arg — typically a colon-joined tuple of the conflicting values.
func uniqueViolation(constraint, key string) error {
	return lic.NewError(lic.CodeUniqueConstraintViolation,
		fmt.Sprintf("unique constraint violated: %s=%s", constraint, key),
		map[string]any{"constraint": constraint, "key": key})
}

// ptrEq is deep equality for *string pointers used by scope_id /
// template_id filters. Two nil pointers are equal; a nil and a non-nil
// are unequal; two non-nil pointers are equal iff their values match.
func ptrEq(a, b *string) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}

// ptrOrNullStr returns the dereferenced value or the literal "null"
// string — used to build unique-constraint key strings that have to
// render nil scope_ids visibly so "global" and "global" collide but
// "global" and "scope-abc" don't.
func ptrOrNullStr(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// orEmptyMap returns the input unchanged when non-nil, or an empty map
// when nil. Keeps adapter output consistent — callers never see nil
// meta/entitlements maps, which would force them to nil-check in every
// read path.
func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// paginate sorts rows by (created_at DESC, id DESC) and slices
// according to the PageRequest. keyFn extracts the (createdAt, id)
// tuple used for ordering and cursor encoding — AuditLog uses
// occurred_at instead of created_at, which is why the extractor is a
// parameter rather than hardcoded.
func paginate[T any](rows []T, page lic.PageRequest, keyFn func(T) (string, string)) lic.Page[T] {
	limit := page.Limit
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	// Sort DESC by (createdAt, id).
	sort.Slice(rows, func(i, j int) bool {
		ac, ai := keyFn(rows[i])
		bc, bi := keyFn(rows[j])
		// DESC: "a before b" means a > b lexicographically.
		return lic.CompareDesc(ac, ai, bc, bi) < 0
	})
	// Find the starting index based on the cursor.
	cursor, hasCursor := lic.DecodeCursor(page.Cursor)
	start := 0
	if hasCursor {
		start = -1
		for i, r := range rows {
			rc, ri := keyFn(r)
			if lic.IsAfter(rc, ri, cursor) {
				start = i
				break
			}
		}
		if start == -1 {
			// Cursor points past the end of the current result set.
			// Return an empty terminal page — gracefully handles stale
			// cursors that no longer reference a live row.
			return lic.Page[T]{Items: []T{}, Cursor: ""}
		}
	}
	end := min(start+limit, len(rows))
	slice := rows[start:end]
	// Copy to a fresh slice so callers can't mutate the internal
	// backing array — cheap since T is usually a value type.
	out := make([]T, len(slice))
	copy(out, slice)
	// Emit a continuation cursor iff more rows remain beyond `end`.
	nextCursor := ""
	if end < len(rows) && len(out) > 0 {
		lastC, lastI := keyFn(out[len(out)-1])
		nextCursor = lic.EncodeCursor(lic.CursorTuple{CreatedAt: lastC, ID: lastI})
	}
	return lic.Page[T]{Items: out, Cursor: nextCursor}
}
