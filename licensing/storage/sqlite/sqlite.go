// Package sqlite provides a Storage implementation backed by SQLite.
//
// Mirrors @anorebel/licensing/storage/sqlite. Uses the same migration set so a
// licensing database populated by either runtime is usable by the other.
// The package uses a pure-Go driver (modernc.org/sqlite) to avoid a CGO
// dependency.
//
// # Differences from Postgres
//
//   - All types are TEXT or INTEGER. Timestamps are ISO-8601 strings
//     stored as TEXT; the adapter generates them on insert (no DEFAULT now()).
//   - JSON columns are TEXT with JSON.parse/stringify in the adapter.
//   - Regex CHECK constraints (slug shape, fingerprint hex) are omitted;
//     the memory and Postgres adapters don't validate at the SQL level
//     either in practice — the domain layer validates input shapes.
//   - PRAGMA foreign_keys = ON and journal_mode = WAL are set on Open.
//   - Transactions use BEGIN IMMEDIATE to acquire a RESERVED lock up-front.
package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	_ "modernc.org/sqlite" // register "sqlite" driver

	lic "github.com/AnoRebel/licensing/licensing"
)

// ---------- Options ----------

// Options configures a Storage.
type Options struct {
	// Clock is used for UUIDv7 generation and created_at/updated_at.
	// Defaults to licensing.SystemClock.
	Clock lic.Clock
}

// ---------- Storage ----------

// Storage is the SQLite implementation of licensing.Storage.
type Storage struct {
	db    *sql.DB
	clock lic.Clock
}

// Compile-time assertions.
var (
	_ lic.Storage   = (*Storage)(nil)
	_ lic.StorageTx = (*sqliteTx)(nil)
)

// Open creates a Storage connected to the SQLite database at path.
// Pass ":memory:" for an in-process test database.
//
// PRAGMAs (foreign_keys, journal_mode=WAL) and txlock=immediate are
// applied via URI query parameters so they affect every connection in
// database/sql's pool, not just the first one.
func Open(path string, opts Options) (*Storage, error) {
	dsn := buildDSN(path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return NewFromDB(db, opts)
}

// buildDSN converts a path into a URI DSN with the required PRAGMAs
// and txlock applied per-connection via the modernc.org/sqlite driver.
func buildDSN(path string) string {
	if path == ":memory:" {
		// In-memory databases must use the URI form.
		return "file::memory:?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_txlock=immediate"
	}
	// File-based databases use the file:// URI form.
	return "file://" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_txlock=immediate"
}

// NewFromDB wraps an existing *sql.DB as a Storage. The caller is
// responsible for closing db. Use this when you've already opened the
// DB with the correct PRAGMAs (e.g., via buildDSN or URI params).
// For convenience, this also runs the PRAGMAs as a best-effort
// fallback for connections not opened through Open().
func NewFromDB(db *sql.DB, opts Options) (*Storage, error) {
	// Best-effort PRAGMA application for connections not opened via
	// buildDSN. If the DSN already set them, these are no-ops.
	for _, pragma := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	var clk lic.Clock = lic.SystemClock{}
	if opts.Clock != nil {
		clk = opts.Clock
	}
	return &Storage{db: db, clock: clk}, nil
}

// ---------- Storage CRUD (delegates through db) ----------

// CreateLicense creates license.
func (s *Storage) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	return createLicense(s.db, s.clock, in)
}

// GetLicense fetches license.
func (s *Storage) GetLicense(id string) (*lic.License, error) {
	return getLicense(s.db, id)
}

// GetLicenseByKey fetches license by key.
func (s *Storage) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	return getLicenseByKey(s.db, licenseKey)
}

// ListLicenses lists licenses.
func (s *Storage) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	return listLicenses(s.db, filter, page)
}

// UpdateLicense updates license.
func (s *Storage) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	return updateLicense(s.db, s.clock, id, patch)
}

// DeleteLicense deletes license.
func (s *Storage) DeleteLicense(id string) error {
	return deleteLicense(s.db, id)
}

// CreateScope creates scope.
func (s *Storage) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	return createScope(s.db, s.clock, in)
}

// GetScope fetches scope.
func (s *Storage) GetScope(id string) (*lic.LicenseScope, error) {
	return getScope(s.db, id)
}

// GetScopeBySlug fetches scope by slug.
func (s *Storage) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	return getScopeBySlug(s.db, slug)
}

// ListScopes lists scopes.
func (s *Storage) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	return listScopes(s.db, filter, page)
}

// UpdateScope updates scope.
func (s *Storage) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	return updateScope(s.db, s.clock, id, patch)
}

// DeleteScope deletes scope.
func (s *Storage) DeleteScope(id string) error {
	return deleteScope(s.db, id)
}

// CreateTemplate creates template.
func (s *Storage) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	return createTemplate(s.db, s.clock, in)
}

// GetTemplate fetches template.
func (s *Storage) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	return getTemplate(s.db, id)
}

// ListTemplates lists templates.
func (s *Storage) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	return listTemplates(s.db, filter, page)
}

// UpdateTemplate updates template.
func (s *Storage) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	return updateTemplate(s.db, s.clock, id, patch)
}

// DeleteTemplate deletes template.
func (s *Storage) DeleteTemplate(id string) error {
	return deleteTemplate(s.db, id)
}

// CreateUsage creates usage.
func (s *Storage) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	return createUsage(s.db, s.clock, in, false)
}

// GetUsage fetches usage.
func (s *Storage) GetUsage(id string) (*lic.LicenseUsage, error) {
	return getUsage(s.db, id)
}

// ListUsages lists usages.
func (s *Storage) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	return listUsages(s.db, filter, page)
}

// UpdateUsage updates usage.
func (s *Storage) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	return updateUsage(s.db, s.clock, id, patch)
}

// CreateKey creates key.
func (s *Storage) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	return createKey(s.db, s.clock, in)
}

// GetKey fetches key.
func (s *Storage) GetKey(id string) (*lic.LicenseKey, error) {
	return getKey(s.db, id)
}

// GetKeyByKid fetches key by kid.
func (s *Storage) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	return getKeyByKid(s.db, kid)
}

// ListKeys lists keys.
func (s *Storage) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	return listKeys(s.db, filter, page)
}

// UpdateKey updates key.
func (s *Storage) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	return updateKey(s.db, s.clock, id, patch)
}

// AppendAudit appends audit.
func (s *Storage) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	return appendAudit(s.db, s.clock, in)
}

// GetAudit fetches audit.
func (s *Storage) GetAudit(id string) (*lic.AuditLogEntry, error) {
	return getAudit(s.db, id)
}

// ListAudit lists audit.
func (s *Storage) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	return listAudit(s.db, filter, page)
}

// WithTransaction runs fn atomically inside BEGIN / COMMIT. On error,
// ROLLBACK is issued. Nested transactions are rejected at the type
// level — sqliteTx has no WithTransaction method.
func (s *Storage) WithTransaction(fn func(tx lic.StorageTx) error) error {
	sqlTx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	tx := &sqliteTx{tx: sqlTx, clock: s.clock}
	if err := fn(tx); err != nil {
		_ = sqlTx.Rollback()
		return err
	}
	return sqlTx.Commit()
}

// DescribeSchema returns the canonical schema; the SQLite adapter's
// actual DDL lives in migrations, and schema-parity tests assert the two
// agree up to logical column types.
func (s *Storage) DescribeSchema() lic.SchemaDescription {
	return lic.CanonicalSchema()
}

// DB returns the underlying *sql.DB, primarily for running migrations.
func (s *Storage) DB() *sql.DB { return s.db }

// Close closes the underlying *sql.DB. After Close the Storage is unusable.
func (s *Storage) Close() error {
	return s.db.Close()
}

// ---------- Transaction handle ----------

type sqliteTx struct {
	tx    *sql.Tx
	clock lic.Clock
}

// CreateLicense creates license.
func (t *sqliteTx) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	return createLicense(t.tx, t.clock, in)
}

// GetLicense fetches license.
func (t *sqliteTx) GetLicense(id string) (*lic.License, error) {
	return getLicense(t.tx, id)
}

// GetLicenseByKey fetches license by key.
func (t *sqliteTx) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	return getLicenseByKey(t.tx, licenseKey)
}

// ListLicenses lists licenses.
func (t *sqliteTx) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	return listLicenses(t.tx, filter, page)
}

// UpdateLicense updates license.
func (t *sqliteTx) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	return updateLicense(t.tx, t.clock, id, patch)
}

// DeleteLicense deletes license.
func (t *sqliteTx) DeleteLicense(id string) error {
	return deleteLicense(t.tx, id)
}

// CreateScope creates scope.
func (t *sqliteTx) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	return createScope(t.tx, t.clock, in)
}

// GetScope fetches scope.
func (t *sqliteTx) GetScope(id string) (*lic.LicenseScope, error) {
	return getScope(t.tx, id)
}

// GetScopeBySlug fetches scope by slug.
func (t *sqliteTx) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	return getScopeBySlug(t.tx, slug)
}

// ListScopes lists scopes.
func (t *sqliteTx) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	return listScopes(t.tx, filter, page)
}

// UpdateScope updates scope.
func (t *sqliteTx) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	return updateScope(t.tx, t.clock, id, patch)
}

// DeleteScope deletes scope.
func (t *sqliteTx) DeleteScope(id string) error {
	return deleteScope(t.tx, id)
}

// CreateTemplate creates template.
func (t *sqliteTx) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	return createTemplate(t.tx, t.clock, in)
}

// GetTemplate fetches template.
func (t *sqliteTx) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	return getTemplate(t.tx, id)
}

// ListTemplates lists templates.
func (t *sqliteTx) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	return listTemplates(t.tx, filter, page)
}

// UpdateTemplate updates template.
func (t *sqliteTx) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	return updateTemplate(t.tx, t.clock, id, patch)
}

// DeleteTemplate deletes template.
func (t *sqliteTx) DeleteTemplate(id string) error {
	return deleteTemplate(t.tx, id)
}

// CreateUsage creates usage.
func (t *sqliteTx) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	return createUsage(t.tx, t.clock, in, true)
}

// GetUsage fetches usage.
func (t *sqliteTx) GetUsage(id string) (*lic.LicenseUsage, error) {
	return getUsage(t.tx, id)
}

// ListUsages lists usages.
func (t *sqliteTx) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	return listUsages(t.tx, filter, page)
}

// UpdateUsage updates usage.
func (t *sqliteTx) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	return updateUsage(t.tx, t.clock, id, patch)
}

// CreateKey creates key.
func (t *sqliteTx) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	return createKey(t.tx, t.clock, in)
}

// GetKey fetches key.
func (t *sqliteTx) GetKey(id string) (*lic.LicenseKey, error) {
	return getKey(t.tx, id)
}

// GetKeyByKid fetches key by kid.
func (t *sqliteTx) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	return getKeyByKid(t.tx, kid)
}

// ListKeys lists keys.
func (t *sqliteTx) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	return listKeys(t.tx, filter, page)
}

// UpdateKey updates key.
func (t *sqliteTx) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	return updateKey(t.tx, t.clock, id, patch)
}

// AppendAudit appends audit.
func (t *sqliteTx) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	return appendAudit(t.tx, t.clock, in)
}

// GetAudit fetches audit.
func (t *sqliteTx) GetAudit(id string) (*lic.AuditLogEntry, error) {
	return getAudit(t.tx, id)
}

// ListAudit lists audit.
func (t *sqliteTx) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	return listAudit(t.tx, filter, page)
}

// ---------- queryable abstraction ----------

// queryable is the subset of database/sql that both *sql.DB and *sql.Tx
// share. Every CRUD function calls only through this interface.
type queryable interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// ---------- Core CRUD ----------

// --- License ---

func createLicense(q queryable, clk lic.Clock, in lic.LicenseInput) (*lic.License, error) {
	id := lic.NewUUIDv7()
	now := clk.NowISO()
	_, err := q.Exec(
		`INSERT INTO licenses (
			id, scope_id, template_id, licensable_type, licensable_id,
			license_key, status, max_usages, activated_at, expires_at,
			grace_until, meta, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, in.ScopeID, in.TemplateID, in.LicensableType, in.LicensableID,
		in.LicenseKey, string(in.Status), in.MaxUsages,
		in.ActivatedAt, in.ExpiresAt, in.GraceUntil,
		jsonText(in.Meta), now, now,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getLicense(q, id)
}

func getLicense(q queryable, id string) (*lic.License, error) {
	return scanOneLicense(q.QueryRow(
		"SELECT * FROM licenses WHERE id = ?", id))
}

func getLicenseByKey(q queryable, licenseKey string) (*lic.License, error) {
	return scanOneLicense(q.QueryRow(
		"SELECT * FROM licenses WHERE license_key = ?", licenseKey))
}

func listLicenses(q queryable, filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = ?", *filter.ScopeID)
		}
	}
	if len(filter.Status) > 0 {
		wb.addIn("status", licStatusAny(filter.Status))
	}
	if filter.LicensableType != nil {
		wb.addParam("licensable_type = ?", *filter.LicensableType)
	}
	if filter.LicensableID != nil {
		wb.addParam("licensable_id = ?", *filter.LicensableID)
	}
	if filter.TemplateIDSet {
		if filter.TemplateID == nil {
			wb.add("template_id IS NULL")
		} else {
			wb.addParam("template_id = ?", *filter.TemplateID)
		}
	}
	return queryPage(q, scanRowLicense, extractLicense, "licenses", "created_at", wb, page)
}

func updateLicense(q queryable, clk lic.Clock, id string, patch lic.LicensePatch) (*lic.License, error) {
	ub := updateBuilder{}
	if patch.Status != nil {
		ub.set("status", string(*patch.Status))
	}
	if patch.MaxUsages != nil {
		ub.set("max_usages", *patch.MaxUsages)
	}
	if patch.ActivatedAt.Set {
		ub.set("activated_at", patch.ActivatedAt.Value)
	}
	if patch.ExpiresAt.Set {
		ub.set("expires_at", patch.ExpiresAt.Value)
	}
	if patch.GraceUntil.Set {
		ub.set("grace_until", patch.GraceUntil.Value)
	}
	if patch.Meta.Set {
		ub.set("meta", jsonText(patch.Meta.Value))
	}
	if patch.ScopeID.Set {
		ub.set("scope_id", patch.ScopeID.Value)
	}
	if patch.TemplateID.Set {
		ub.set("template_id", patch.TemplateID.Value)
	}
	row, err := execUpdate(q, clk, scanRowLicense, "licenses", id, ub)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return row, nil
}

func deleteLicense(q queryable, id string) error {
	// Pre-check for active usages → 409.
	row := q.QueryRow(
		`SELECT COUNT(*) FROM license_usages
		 WHERE license_id = ? AND status = 'active'`, id)
	var n int
	if err := row.Scan(&n); err != nil {
		return mapSqliteError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"license "+id+" has active usages — revoke them before deleting",
			map[string]any{"id": id, "active_usages": n})
	}
	// Clear revoked usage rows so the RESTRICT FK doesn't block the license delete.
	if _, err := q.Exec(`DELETE FROM license_usages WHERE license_id = ?`, id); err != nil {
		return mapSqliteError(err)
	}
	res, err := q.Exec(`DELETE FROM licenses WHERE id = ?`, id)
	if err != nil {
		return mapSqliteError(err)
	}
	n64, _ := res.RowsAffected()
	if n64 == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"license not found: "+id,
			map[string]any{"id": id})
	}
	return nil
}

// --- LicenseScope ---

func createScope(q queryable, clk lic.Clock, in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	id := lic.NewUUIDv7()
	now := clk.NowISO()
	_, err := q.Exec(
		`INSERT INTO license_scopes (id, slug, name, meta, created_at, updated_at)
		VALUES (?,?,?,?,?,?)`,
		id, in.Slug, in.Name, jsonText(in.Meta), now, now,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getScope(q, id)
}

func getScope(q queryable, id string) (*lic.LicenseScope, error) {
	return scanOneScope(q.QueryRow("SELECT * FROM license_scopes WHERE id = ?", id))
}

func getScopeBySlug(q queryable, slug string) (*lic.LicenseScope, error) {
	return scanOneScope(q.QueryRow("SELECT * FROM license_scopes WHERE slug = ?", slug))
}

func listScopes(q queryable, filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	wb := whereBuilder{}
	if filter.Slug != nil {
		wb.addParam("slug = ?", *filter.Slug)
	}
	return queryPage(q, scanRowScope, extractScope, "license_scopes", "created_at", wb, page)
}

func updateScope(q queryable, clk lic.Clock, id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	ub := updateBuilder{}
	if patch.Name != nil {
		ub.set("name", *patch.Name)
	}
	if patch.Meta.Set {
		ub.set("meta", jsonText(patch.Meta.Value))
	}
	row, err := execUpdate(q, clk, scanRowScope, "license_scopes", id, ub)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return row, nil
}

func deleteScope(q queryable, id string) error {
	// 409 if any license or template references the scope.
	var n int
	if err := q.QueryRow(
		`SELECT COUNT(*) FROM licenses WHERE scope_id = ?`, id,
	).Scan(&n); err != nil {
		return mapSqliteError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"scope "+id+" is referenced by licenses",
			map[string]any{"id": id, "license_refs": n})
	}
	if err := q.QueryRow(
		`SELECT COUNT(*) FROM license_templates WHERE scope_id = ?`, id,
	).Scan(&n); err != nil {
		return mapSqliteError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"scope "+id+" is referenced by templates",
			map[string]any{"id": id, "template_refs": n})
	}
	res, err := q.Exec(`DELETE FROM license_scopes WHERE id = ?`, id)
	if err != nil {
		return mapSqliteError(err)
	}
	n64, _ := res.RowsAffected()
	if n64 == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"scope not found: "+id,
			map[string]any{"id": id})
	}
	return nil
}

// --- LicenseTemplate ---

func createTemplate(q queryable, clk lic.Clock, in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	id := lic.NewUUIDv7()
	now := clk.NowISO()
	_, err := q.Exec(
		`INSERT INTO license_templates (
			id, scope_id, name, max_usages, trial_duration_sec, grace_duration_sec,
			force_online_after_sec, entitlements, meta, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		id, in.ScopeID, in.Name, in.MaxUsages,
		in.TrialDurationSec, in.GraceDurationSec,
		in.ForceOnlineAfterSec,
		jsonText(in.Entitlements), jsonText(in.Meta), now, now,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getTemplate(q, id)
}

func getTemplate(q queryable, id string) (*lic.LicenseTemplate, error) {
	return scanOneTemplate(q.QueryRow("SELECT * FROM license_templates WHERE id = ?", id))
}

func listTemplates(q queryable, filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = ?", *filter.ScopeID)
		}
	}
	if filter.Name != nil {
		wb.addParam("name = ?", *filter.Name)
	}
	return queryPage(q, scanRowTemplate, extractTemplate, "license_templates", "created_at", wb, page)
}

func updateTemplate(q queryable, clk lic.Clock, id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	ub := updateBuilder{}
	if patch.Name != nil {
		ub.set("name", *patch.Name)
	}
	if patch.MaxUsages != nil {
		ub.set("max_usages", *patch.MaxUsages)
	}
	if patch.TrialDurationSec != nil {
		ub.set("trial_duration_sec", *patch.TrialDurationSec)
	}
	if patch.GraceDurationSec != nil {
		ub.set("grace_duration_sec", *patch.GraceDurationSec)
	}
	if patch.ForceOnlineAfterSec.Set {
		ub.set("force_online_after_sec", patch.ForceOnlineAfterSec.Value)
	}
	if patch.Entitlements.Set {
		ub.set("entitlements", jsonText(patch.Entitlements.Value))
	}
	if patch.Meta.Set {
		ub.set("meta", jsonText(patch.Meta.Value))
	}
	row, err := execUpdate(q, clk, scanRowTemplate, "license_templates", id, ub)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return row, nil
}

func deleteTemplate(q queryable, id string) error {
	var n int
	if err := q.QueryRow(
		`SELECT COUNT(*) FROM licenses WHERE template_id = ?`, id,
	).Scan(&n); err != nil {
		return mapSqliteError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"template "+id+" is referenced by licenses",
			map[string]any{"id": id, "license_refs": n})
	}
	res, err := q.Exec(`DELETE FROM license_templates WHERE id = ?`, id)
	if err != nil {
		return mapSqliteError(err)
	}
	n64, _ := res.RowsAffected()
	if n64 == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"template not found: "+id,
			map[string]any{"id": id})
	}
	return nil
}

// --- LicenseUsage ---

func createUsage(q queryable, clk lic.Clock, in lic.LicenseUsageInput, inTx bool) (*lic.LicenseUsage, error) {
	// Seat check: lock parent license row if inside a transaction.
	if inTx {
		// SQLite doesn't have SELECT … FOR UPDATE, but since
		// we're inside a serialized transaction (BEGIN IMMEDIATE),
		// reads are already serialized.
		var exists bool
		err := q.QueryRow("SELECT EXISTS(SELECT 1 FROM licenses WHERE id = ?)", in.LicenseID).Scan(&exists)
		if err != nil {
			return nil, err
		}
	}
	id := lic.NewUUIDv7()
	now := clk.NowISO()
	_, err := q.Exec(
		`INSERT INTO license_usages (
			id, license_id, fingerprint, status, registered_at, revoked_at,
			client_meta, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?)`,
		id, in.LicenseID, in.Fingerprint, string(in.Status),
		in.RegisteredAt, in.RevokedAt,
		jsonText(in.ClientMeta), now, now,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getUsage(q, id)
}

func getUsage(q queryable, id string) (*lic.LicenseUsage, error) {
	return scanOneUsage(q.QueryRow("SELECT * FROM license_usages WHERE id = ?", id))
}

func listUsages(q queryable, filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	wb := whereBuilder{}
	if filter.LicenseID != nil {
		wb.addParam("license_id = ?", *filter.LicenseID)
	}
	if filter.Fingerprint != nil {
		wb.addParam("fingerprint = ?", *filter.Fingerprint)
	}
	if len(filter.Status) > 0 {
		wb.addIn("status", usageStatusAny(filter.Status))
	}
	return queryPage(q, scanRowUsage, extractUsage, "license_usages", "created_at", wb, page)
}

func updateUsage(q queryable, clk lic.Clock, id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	ub := updateBuilder{}
	if patch.Status != nil {
		ub.set("status", string(*patch.Status))
	}
	if patch.RevokedAt.Set {
		ub.set("revoked_at", patch.RevokedAt.Value)
	}
	if patch.ClientMeta.Set {
		ub.set("client_meta", jsonText(patch.ClientMeta.Value))
	}
	row, err := execUpdate(q, clk, scanRowUsage, "license_usages", id, ub)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return row, nil
}

// --- LicenseKey ---

func createKey(q queryable, clk lic.Clock, in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	id := lic.NewUUIDv7()
	now := clk.NowISO()
	_, err := q.Exec(
		`INSERT INTO license_keys (
			id, scope_id, kid, alg, role, state, public_pem, private_pem_enc,
			rotated_from, rotated_at, not_before, not_after, meta, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, in.ScopeID, in.Kid, string(in.Alg), string(in.Role), string(in.State),
		in.PublicPem, in.PrivatePemEnc,
		in.RotatedFrom, in.RotatedAt,
		in.NotBefore, in.NotAfter,
		jsonText(in.Meta), now, now,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getKey(q, id)
}

func getKey(q queryable, id string) (*lic.LicenseKey, error) {
	return scanOneKey(q.QueryRow("SELECT * FROM license_keys WHERE id = ?", id))
}

func getKeyByKid(q queryable, kid string) (*lic.LicenseKey, error) {
	return scanOneKey(q.QueryRow("SELECT * FROM license_keys WHERE kid = ?", kid))
}

func listKeys(q queryable, filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = ?", *filter.ScopeID)
		}
	}
	if filter.Kid != nil {
		wb.addParam("kid = ?", *filter.Kid)
	}
	if filter.Alg != nil {
		wb.addParam("alg = ?", string(*filter.Alg))
	}
	if filter.Role != nil {
		wb.addParam("role = ?", string(*filter.Role))
	}
	if filter.State != nil {
		wb.addParam("state = ?", string(*filter.State))
	}
	return queryPage(q, scanRowKey, extractKey, "license_keys", "created_at", wb, page)
}

func updateKey(q queryable, clk lic.Clock, id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	ub := updateBuilder{}
	if patch.State != nil {
		ub.set("state", string(*patch.State))
	}
	if patch.RotatedFrom.Set {
		ub.set("rotated_from", patch.RotatedFrom.Value)
	}
	if patch.RotatedAt.Set {
		ub.set("rotated_at", patch.RotatedAt.Value)
	}
	if patch.NotAfter.Set {
		ub.set("not_after", patch.NotAfter.Value)
	}
	if patch.Meta.Set {
		ub.set("meta", jsonText(patch.Meta.Value))
	}
	row, err := execUpdate(q, clk, scanRowKey, "license_keys", id, ub)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return row, nil
}

// --- AuditLog ---

func appendAudit(q queryable, _ lic.Clock, in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	id := lic.NewUUIDv7()
	_, err := q.Exec(
		`INSERT INTO audit_logs (
			id, license_id, scope_id, actor, event, prior_state, new_state, occurred_at
		) VALUES (?,?,?,?,?,?,?,?)`,
		id, in.LicenseID, in.ScopeID, in.Actor, in.Event,
		jsonTextNullable(in.PriorState), jsonTextNullable(in.NewState),
		in.OccurredAt,
	)
	if err != nil {
		return nil, mapSqliteError(err)
	}
	return getAudit(q, id)
}

func getAudit(q queryable, id string) (*lic.AuditLogEntry, error) {
	return scanOneAudit(q.QueryRow("SELECT * FROM audit_logs WHERE id = ?", id))
}

func listAudit(q queryable, filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	wb := whereBuilder{}
	if filter.LicenseIDSet {
		if filter.LicenseID == nil {
			wb.add("license_id IS NULL")
		} else {
			wb.addParam("license_id = ?", *filter.LicenseID)
		}
	}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = ?", *filter.ScopeID)
		}
	}
	if filter.Event != nil {
		wb.addParam("event = ?", *filter.Event)
	}
	return queryPage(q, scanRowAudit, extractAudit, "audit_logs", "occurred_at", wb, page)
}

// ---------- Row scanners ----------

// SQLite stores everything as TEXT. We scan into *string for nullable
// columns, string for non-nullable, and int for integer columns.

func scanOneLicense(row *sql.Row) (*lic.License, error) {
	var (
		r        lic.License
		metaJSON string
		isTrial  int // SQLite stores BOOL as 0/1.
	)
	err := row.Scan(
		&r.ID, &r.ScopeID, &r.TemplateID,
		&r.LicensableType, &r.LicensableID,
		&r.LicenseKey, &r.Status, &r.MaxUsages,
		&r.ActivatedAt, &r.ExpiresAt, &r.GraceUntil,
		&metaJSON, &r.CreatedAt, &r.UpdatedAt,
		&isTrial,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	r.IsTrial = isTrial != 0
	return &r, nil
}

func scanRowLicense(rows *sql.Rows) (*lic.License, error) {
	var (
		r        lic.License
		metaJSON string
		isTrial  int
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.TemplateID,
		&r.LicensableType, &r.LicensableID,
		&r.LicenseKey, &r.Status, &r.MaxUsages,
		&r.ActivatedAt, &r.ExpiresAt, &r.GraceUntil,
		&metaJSON, &r.CreatedAt, &r.UpdatedAt,
		&isTrial,
	)
	if err != nil {
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	r.IsTrial = isTrial != 0
	return &r, nil
}

func scanOneScope(row *sql.Row) (*lic.LicenseScope, error) {
	var (
		r        lic.LicenseScope
		metaJSON string
	)
	err := row.Scan(&r.ID, &r.Slug, &r.Name, &metaJSON, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanRowScope(rows *sql.Rows) (*lic.LicenseScope, error) {
	var (
		r        lic.LicenseScope
		metaJSON string
	)
	err := rows.Scan(&r.ID, &r.Slug, &r.Name, &metaJSON, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanOneTemplate(row *sql.Row) (*lic.LicenseTemplate, error) {
	var (
		r                 lic.LicenseTemplate
		entJSON, metaJSON string
	)
	err := row.Scan(
		&r.ID, &r.ScopeID, &r.Name,
		&r.MaxUsages, &r.TrialDurationSec, &r.GraceDurationSec,
		&r.ForceOnlineAfterSec,
		&entJSON, &metaJSON, &r.CreatedAt, &r.UpdatedAt,
		// v0002 columns appended via ALTER TABLE — read in the order they were added.
		&r.ParentID, &r.TrialCooldownSec,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Entitlements = jsonFromText(entJSON)
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanRowTemplate(rows *sql.Rows) (*lic.LicenseTemplate, error) {
	var (
		r                 lic.LicenseTemplate
		entJSON, metaJSON string
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.Name,
		&r.MaxUsages, &r.TrialDurationSec, &r.GraceDurationSec,
		&r.ForceOnlineAfterSec,
		&entJSON, &metaJSON, &r.CreatedAt, &r.UpdatedAt,
		&r.ParentID, &r.TrialCooldownSec,
	)
	if err != nil {
		return nil, err
	}
	r.Entitlements = jsonFromText(entJSON)
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanOneUsage(row *sql.Row) (*lic.LicenseUsage, error) {
	var (
		r          lic.LicenseUsage
		clientJSON string
	)
	err := row.Scan(
		&r.ID, &r.LicenseID, &r.Fingerprint, &r.Status,
		&r.RegisteredAt, &r.RevokedAt, &clientJSON,
		&r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.ClientMeta = jsonFromText(clientJSON)
	return &r, nil
}

func scanRowUsage(rows *sql.Rows) (*lic.LicenseUsage, error) {
	var (
		r          lic.LicenseUsage
		clientJSON string
	)
	err := rows.Scan(
		&r.ID, &r.LicenseID, &r.Fingerprint, &r.Status,
		&r.RegisteredAt, &r.RevokedAt, &clientJSON,
		&r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	r.ClientMeta = jsonFromText(clientJSON)
	return &r, nil
}

func scanOneKey(row *sql.Row) (*lic.LicenseKey, error) {
	var (
		r        lic.LicenseKey
		metaJSON string
	)
	err := row.Scan(
		&r.ID, &r.ScopeID, &r.Kid, &r.Alg, &r.Role, &r.State,
		&r.PublicPem, &r.PrivatePemEnc,
		&r.RotatedFrom, &r.RotatedAt,
		&r.NotBefore, &r.NotAfter,
		&metaJSON, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanRowKey(rows *sql.Rows) (*lic.LicenseKey, error) {
	var (
		r        lic.LicenseKey
		metaJSON string
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.Kid, &r.Alg, &r.Role, &r.State,
		&r.PublicPem, &r.PrivatePemEnc,
		&r.RotatedFrom, &r.RotatedAt,
		&r.NotBefore, &r.NotAfter,
		&metaJSON, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	r.Meta = jsonFromText(metaJSON)
	return &r, nil
}

func scanOneAudit(row *sql.Row) (*lic.AuditLogEntry, error) {
	var (
		r                       lic.AuditLogEntry
		priorJSON, newstateJSON *string
	)
	err := row.Scan(
		&r.ID, &r.LicenseID, &r.ScopeID,
		&r.Actor, &r.Event,
		&priorJSON, &newstateJSON,
		&r.OccurredAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.PriorState = jsonFromTextNullable(priorJSON)
	r.NewState = jsonFromTextNullable(newstateJSON)
	return &r, nil
}

func scanRowAudit(rows *sql.Rows) (*lic.AuditLogEntry, error) {
	var (
		r                       lic.AuditLogEntry
		priorJSON, newstateJSON *string
	)
	err := rows.Scan(
		&r.ID, &r.LicenseID, &r.ScopeID,
		&r.Actor, &r.Event,
		&priorJSON, &newstateJSON,
		&r.OccurredAt,
	)
	if err != nil {
		return nil, err
	}
	r.PriorState = jsonFromTextNullable(priorJSON)
	r.NewState = jsonFromTextNullable(newstateJSON)
	return &r, nil
}

// ---------- Cursor extractors ----------

func extractLicense(r *lic.License) (string, string)          { return r.CreatedAt, r.ID }
func extractScope(r *lic.LicenseScope) (string, string)       { return r.CreatedAt, r.ID }
func extractTemplate(r *lic.LicenseTemplate) (string, string) { return r.CreatedAt, r.ID }
func extractUsage(r *lic.LicenseUsage) (string, string)       { return r.CreatedAt, r.ID }
func extractKey(r *lic.LicenseKey) (string, string)           { return r.CreatedAt, r.ID }
func extractAudit(r *lic.AuditLogEntry) (string, string)      { return r.OccurredAt, r.ID }

// ---------- Pagination ----------

type rowScanFunc[T any] func(rows *sql.Rows) (*T, error)
type tsIDFunc[T any] func(row *T) (ts string, id string)

func queryPage[T any](
	q queryable, scan rowScanFunc[T], extract tsIDFunc[T],
	table, tsCol string, wb whereBuilder, page lic.PageRequest,
) (lic.Page[T], error) {
	limit := max(1, min(page.Limit, 500))

	cursor, ok := lic.DecodeCursor(page.Cursor)
	if ok {
		wb.addParam2(fmt.Sprintf("(%s, id) < (?, ?)", tsCol), cursor.CreatedAt, cursor.ID)
	}

	where := wb.build()
	query := fmt.Sprintf("SELECT * FROM %s WHERE %s ORDER BY %s DESC, id DESC LIMIT %d",
		table, where, tsCol, limit+1)

	rows, err := q.Query(query, wb.params...)
	if err != nil {
		return lic.Page[T]{}, err
	}
	defer rows.Close()

	var items []*T
	for rows.Next() {
		row, err := scan(rows)
		if err != nil {
			return lic.Page[T]{}, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return lic.Page[T]{}, err
	}

	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}

	result := lic.Page[T]{Items: make([]T, len(items))}
	for i, ptr := range items {
		result.Items[i] = *ptr
	}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		ts, id := extract(last)
		result.Cursor = lic.EncodeCursor(lic.CursorTuple{
			CreatedAt: ts,
			ID:        id,
		})
	}
	return result, nil
}

// ---------- UPDATE builder ----------

type updateBuilder struct {
	cols   []string
	params []any
}

func (u *updateBuilder) set(col string, val any) {
	u.params = append(u.params, val)
	u.cols = append(u.cols, col+" = ?")
}

func (u *updateBuilder) isEmpty() bool { return len(u.cols) == 0 }

func execUpdate[T any](
	q queryable, clk lic.Clock, scan rowScanFunc[T],
	table, id string, ub updateBuilder,
) (*T, error) {
	now := clk.NowISO()
	if ub.isEmpty() {
		// Empty patch — just bump updated_at.
		_, err := q.Exec(
			fmt.Sprintf("UPDATE %s SET updated_at = ? WHERE id = ?", table),
			now, id)
		if err != nil {
			return nil, err
		}
	} else {
		ub.set("updated_at", now)
		ub.params = append(ub.params, id)
		_, err := q.Exec(
			fmt.Sprintf("UPDATE %s SET %s WHERE id = ?", table, strings.Join(ub.cols, ", ")),
			ub.params...)
		if err != nil {
			return nil, err
		}
	}
	// Re-select to return the updated row.
	rows, err := q.Query(fmt.Sprintf("SELECT * FROM %s WHERE id = ?", table), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return scan(rows)
}

// ---------- WHERE builder ----------

type whereBuilder struct {
	clauses []string
	params  []any
}

func (w *whereBuilder) add(clause string) {
	w.clauses = append(w.clauses, clause)
}

func (w *whereBuilder) addParam(clause string, val any) {
	w.params = append(w.params, val)
	w.clauses = append(w.clauses, clause)
}

func (w *whereBuilder) addParam2(clause string, val1, val2 any) {
	w.params = append(w.params, val1, val2)
	w.clauses = append(w.clauses, clause)
}

func (w *whereBuilder) addIn(col string, vals []any) {
	if len(vals) == 0 {
		return
	}
	placeholders := make([]string, len(vals))
	for i, v := range vals {
		w.params = append(w.params, v)
		placeholders[i] = "?"
	}
	w.clauses = append(w.clauses, fmt.Sprintf("%s IN (%s)", col, strings.Join(placeholders, ",")))
}

func (w *whereBuilder) build() string {
	if len(w.clauses) == 0 {
		return "1=1"
	}
	return strings.Join(w.clauses, " AND ")
}

// ---------- Type converters ----------

// jsonText marshals a map to a JSON string for TEXT columns. Nil → "{}".
func jsonText(m map[string]any) string {
	if m == nil {
		return "{}"
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// jsonTextNullable returns nil for SQL NULL, otherwise marshals to JSON text.
func jsonTextNullable(m map[string]any) *string {
	if m == nil {
		return nil
	}
	s := jsonText(m)
	return &s
}

// jsonFromText parses a JSON TEXT column into a map. Empty/invalid → {}.
func jsonFromText(s string) map[string]any {
	if s == "" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return map[string]any{}
	}
	return m
}

// jsonFromTextNullable handles nullable JSON TEXT columns.
func jsonFromTextNullable(s *string) map[string]any {
	if s == nil {
		return nil
	}
	return jsonFromText(*s)
}

// licStatusAny converts []LicenseStatus to []any for IN clauses.
func licStatusAny(statuses []lic.LicenseStatus) []any {
	out := make([]any, len(statuses))
	for i, s := range statuses {
		out[i] = string(s)
	}
	return out
}

// usageStatusAny converts []UsageStatus to []any for IN clauses.
func usageStatusAny(statuses []lic.UsageStatus) []any {
	out := make([]any, len(statuses))
	for i, s := range statuses {
		out[i] = string(s)
	}
	return out
}
