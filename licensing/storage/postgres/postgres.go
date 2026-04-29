// Package postgres provides a Storage implementation backed by PostgreSQL.
//
// Mirrors @anorebel/licensing/storage/postgres. Uses the same migration set so a
// licensing database populated by either runtime is usable by the other.
//
// # Architecture
//
// The adapter accepts a *pgxpool.Pool for connection pooling. Calling
// WithTransaction checks out a connection, issues BEGIN, hands fn a
// *postgresTx bound to that pgx.Tx, and COMMITs on success or ROLLBACKs
// on any error. Nested transactions are rejected — the memory adapter
// behaves the same way, and savepoint plumbing would drift from that
// contract.
//
// # Seat-count correctness
//
// CreateUsage inside a transaction issues SELECT … FOR UPDATE on the
// parent license row, serializing concurrent registration attempts.
//
// # AuditLog immutability
//
// Enforced by the migration-installed trigger. No UpdateAudit /
// DeleteAudit methods exist — immutability by construction.
//
// # Timestamp handling
//
// Postgres timestamptz ↔ time.Time ↔ ISO-8601 string with microsecond
// precision. The core's cursor pagination relies on lexical ordering of
// the string form, so we NEVER hand out a time.Time to callers.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ---------- queryable abstraction ----------

// queryable is the subset of pgx that both *pgxpool.Pool and pgx.Tx
// share. Every CRUD method calls only through this interface so the
// same SQL works outside and inside a transaction.
type queryable interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ---------- Options ----------

// Options configures a Storage.
type Options struct {
	// Clock is used for UUIDv7 generation. Defaults to
	// licensing.SystemClock if nil.
	Clock lic.Clock
}

// ---------- Storage ----------

// Storage is the Postgres implementation of licensing.Storage.
type Storage struct {
	pool  *pgxpool.Pool
	clock lic.Clock
}

// Compile-time assertions.
var (
	_ lic.Storage   = (*Storage)(nil)
	_ lic.StorageTx = (*postgresTx)(nil)
)

// New builds a Postgres storage backed by pool.
func New(pool *pgxpool.Pool, opts Options) *Storage {
	var clk lic.Clock = lic.SystemClock{}
	if opts.Clock != nil {
		clk = opts.Clock
	}
	return &Storage{pool: pool, clock: clk}
}

// ---------- Storage CRUD (delegates through pool) ----------

// CreateLicense creates license.
func (s *Storage) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	return createLicense(context.Background(), s.pool, s.clock, in)
}

// GetLicense fetches license.
func (s *Storage) GetLicense(id string) (*lic.License, error) {
	return getLicense(context.Background(), s.pool, id)
}

// GetLicenseByKey fetches license by key.
func (s *Storage) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	return getLicenseByKey(context.Background(), s.pool, licenseKey)
}

// ListLicenses lists licenses.
func (s *Storage) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	return listLicenses(context.Background(), s.pool, filter, page)
}

// FindLicensesByLicensable returns every license matching the polymorphic
// (licensable_type, licensable_id), ordered by created_at DESC. Uses the
// licenses_licensable_type_id_idx index introduced in v0002.
func (s *Storage) FindLicensesByLicensable(query lic.FindByLicensableQuery) ([]lic.License, error) {
	return findLicensesByLicensable(context.Background(), s.pool, query)
}

// UpdateLicense updates license.
func (s *Storage) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	return updateLicense(context.Background(), s.pool, id, patch)
}

// DeleteLicense deletes license.
func (s *Storage) DeleteLicense(id string) error {
	return deleteLicense(context.Background(), s.pool, id)
}

// CreateScope creates scope.
func (s *Storage) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	return createScope(context.Background(), s.pool, s.clock, in)
}

// GetScope fetches scope.
func (s *Storage) GetScope(id string) (*lic.LicenseScope, error) {
	return getScope(context.Background(), s.pool, id)
}

// GetScopeBySlug fetches scope by slug.
func (s *Storage) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	return getScopeBySlug(context.Background(), s.pool, slug)
}

// ListScopes lists scopes.
func (s *Storage) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	return listScopes(context.Background(), s.pool, filter, page)
}

// UpdateScope updates scope.
func (s *Storage) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	return updateScope(context.Background(), s.pool, id, patch)
}

// DeleteScope deletes scope.
func (s *Storage) DeleteScope(id string) error {
	return deleteScope(context.Background(), s.pool, id)
}

// CreateTemplate creates template.
func (s *Storage) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	return createTemplate(context.Background(), s.pool, s.clock, in)
}

// GetTemplate fetches template.
func (s *Storage) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	return getTemplate(context.Background(), s.pool, id)
}

// ListTemplates lists templates.
func (s *Storage) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	return listTemplates(context.Background(), s.pool, filter, page)
}

// UpdateTemplate updates template.
func (s *Storage) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	return updateTemplate(context.Background(), s.pool, id, patch)
}

// DeleteTemplate deletes template.
func (s *Storage) DeleteTemplate(id string) error {
	return deleteTemplate(context.Background(), s.pool, id)
}

// CreateUsage creates usage.
func (s *Storage) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	return createUsage(context.Background(), s.pool, s.clock, in, false)
}

// GetUsage fetches usage.
func (s *Storage) GetUsage(id string) (*lic.LicenseUsage, error) {
	return getUsage(context.Background(), s.pool, id)
}

// ListUsages lists usages.
func (s *Storage) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	return listUsages(context.Background(), s.pool, filter, page)
}

// UpdateUsage updates usage.
func (s *Storage) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	return updateUsage(context.Background(), s.pool, id, patch)
}

// CreateKey creates key.
func (s *Storage) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	return createKey(context.Background(), s.pool, s.clock, in)
}

// GetKey fetches key.
func (s *Storage) GetKey(id string) (*lic.LicenseKey, error) {
	return getKey(context.Background(), s.pool, id)
}

// GetKeyByKid fetches key by kid.
func (s *Storage) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	return getKeyByKid(context.Background(), s.pool, kid)
}

// ListKeys lists keys.
func (s *Storage) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	return listKeys(context.Background(), s.pool, filter, page)
}

// UpdateKey updates key.
func (s *Storage) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	return updateKey(context.Background(), s.pool, id, patch)
}

// AppendAudit appends audit.
func (s *Storage) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	return appendAudit(context.Background(), s.pool, s.clock, in)
}

// GetAudit fetches audit.
func (s *Storage) GetAudit(id string) (*lic.AuditLogEntry, error) {
	return getAudit(context.Background(), s.pool, id)
}

// ListAudit lists audit.
func (s *Storage) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	return listAudit(context.Background(), s.pool, filter, page)
}

// RecordTrialIssuance writes a trial-dedupe row.
func (s *Storage) RecordTrialIssuance(in lic.TrialIssuanceInput) (*lic.TrialIssuance, error) {
	return recordTrialIssuance(context.Background(), s.pool, in)
}

// FindTrialIssuance returns the most recent trial issuance for the pair, or nil.
func (s *Storage) FindTrialIssuance(query lic.TrialIssuanceLookup) (*lic.TrialIssuance, error) {
	return findTrialIssuance(context.Background(), s.pool, query)
}

// DeleteTrialIssuance hard-deletes a trial-issuance row.
func (s *Storage) DeleteTrialIssuance(id string) error {
	return deleteTrialIssuance(context.Background(), s.pool, id)
}

// WithTransaction runs fn atomically inside BEGIN/COMMIT. On error,
// ROLLBACK is issued. Nested transactions are rejected.
func (s *Storage) WithTransaction(fn func(tx lic.StorageTx) error) error {
	ctx := context.Background()
	pgTx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	tx := &postgresTx{tx: pgTx, clock: s.clock}
	if err := fn(tx); err != nil {
		_ = pgTx.Rollback(ctx)
		return err
	}
	return pgTx.Commit(ctx)
}

// DescribeSchema returns the canonical schema; the Postgres adapter's
// actual DDL lives in migrations, and schema-parity tests assert the two
// agree up to logical column types.
func (s *Storage) DescribeSchema() lic.SchemaDescription {
	return lic.CanonicalSchema()
}

// Close releases the connection pool. After Close the Storage is unusable.
func (s *Storage) Close() error {
	s.pool.Close()
	return nil
}

// ---------- Transaction handle ----------

// postgresTx is the StorageTx passed to fn inside WithTransaction.
// It uses the pgx.Tx for all operations; no WithTransaction method
// is exposed — nested transactions are prevented at the type level.
type postgresTx struct {
	tx    pgx.Tx
	clock lic.Clock
}

// CreateLicense creates license.
func (t *postgresTx) CreateLicense(in lic.LicenseInput) (*lic.License, error) {
	return createLicense(context.Background(), t.tx, t.clock, in)
}

// GetLicense fetches license.
func (t *postgresTx) GetLicense(id string) (*lic.License, error) {
	return getLicense(context.Background(), t.tx, id)
}

// GetLicenseByKey fetches license by key.
func (t *postgresTx) GetLicenseByKey(licenseKey string) (*lic.License, error) {
	return getLicenseByKey(context.Background(), t.tx, licenseKey)
}

// ListLicenses lists licenses.
func (t *postgresTx) ListLicenses(filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	return listLicenses(context.Background(), t.tx, filter, page)
}

// FindLicensesByLicensable mirrors Storage.FindLicensesByLicensable inside a tx.
func (t *postgresTx) FindLicensesByLicensable(query lic.FindByLicensableQuery) ([]lic.License, error) {
	return findLicensesByLicensable(context.Background(), t.tx, query)
}

// UpdateLicense updates license.
func (t *postgresTx) UpdateLicense(id string, patch lic.LicensePatch) (*lic.License, error) {
	return updateLicense(context.Background(), t.tx, id, patch)
}

// DeleteLicense deletes license.
func (t *postgresTx) DeleteLicense(id string) error {
	return deleteLicense(context.Background(), t.tx, id)
}

// CreateScope creates scope.
func (t *postgresTx) CreateScope(in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	return createScope(context.Background(), t.tx, t.clock, in)
}

// GetScope fetches scope.
func (t *postgresTx) GetScope(id string) (*lic.LicenseScope, error) {
	return getScope(context.Background(), t.tx, id)
}

// GetScopeBySlug fetches scope by slug.
func (t *postgresTx) GetScopeBySlug(slug string) (*lic.LicenseScope, error) {
	return getScopeBySlug(context.Background(), t.tx, slug)
}

// ListScopes lists scopes.
func (t *postgresTx) ListScopes(filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	return listScopes(context.Background(), t.tx, filter, page)
}

// UpdateScope updates scope.
func (t *postgresTx) UpdateScope(id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	return updateScope(context.Background(), t.tx, id, patch)
}

// DeleteScope deletes scope.
func (t *postgresTx) DeleteScope(id string) error {
	return deleteScope(context.Background(), t.tx, id)
}

// CreateTemplate creates template.
func (t *postgresTx) CreateTemplate(in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	return createTemplate(context.Background(), t.tx, t.clock, in)
}

// GetTemplate fetches template.
func (t *postgresTx) GetTemplate(id string) (*lic.LicenseTemplate, error) {
	return getTemplate(context.Background(), t.tx, id)
}

// ListTemplates lists templates.
func (t *postgresTx) ListTemplates(filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	return listTemplates(context.Background(), t.tx, filter, page)
}

// UpdateTemplate updates template.
func (t *postgresTx) UpdateTemplate(id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	return updateTemplate(context.Background(), t.tx, id, patch)
}

// DeleteTemplate deletes template.
func (t *postgresTx) DeleteTemplate(id string) error {
	return deleteTemplate(context.Background(), t.tx, id)
}

// CreateUsage creates usage.
func (t *postgresTx) CreateUsage(in lic.LicenseUsageInput) (*lic.LicenseUsage, error) {
	return createUsage(context.Background(), t.tx, t.clock, in, true)
}

// GetUsage fetches usage.
func (t *postgresTx) GetUsage(id string) (*lic.LicenseUsage, error) {
	return getUsage(context.Background(), t.tx, id)
}

// ListUsages lists usages.
func (t *postgresTx) ListUsages(filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	return listUsages(context.Background(), t.tx, filter, page)
}

// UpdateUsage updates usage.
func (t *postgresTx) UpdateUsage(id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	return updateUsage(context.Background(), t.tx, id, patch)
}

// CreateKey creates key.
func (t *postgresTx) CreateKey(in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	return createKey(context.Background(), t.tx, t.clock, in)
}

// GetKey fetches key.
func (t *postgresTx) GetKey(id string) (*lic.LicenseKey, error) {
	return getKey(context.Background(), t.tx, id)
}

// GetKeyByKid fetches key by kid.
func (t *postgresTx) GetKeyByKid(kid string) (*lic.LicenseKey, error) {
	return getKeyByKid(context.Background(), t.tx, kid)
}

// ListKeys lists keys.
func (t *postgresTx) ListKeys(filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	return listKeys(context.Background(), t.tx, filter, page)
}

// UpdateKey updates key.
func (t *postgresTx) UpdateKey(id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	return updateKey(context.Background(), t.tx, id, patch)
}

// AppendAudit appends audit.
func (t *postgresTx) AppendAudit(in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	return appendAudit(context.Background(), t.tx, t.clock, in)
}

// GetAudit fetches audit.
func (t *postgresTx) GetAudit(id string) (*lic.AuditLogEntry, error) {
	return getAudit(context.Background(), t.tx, id)
}

// ListAudit lists audit.
func (t *postgresTx) ListAudit(filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	return listAudit(context.Background(), t.tx, filter, page)
}

// RecordTrialIssuance records a trial-dedupe row inside a tx.
func (t *postgresTx) RecordTrialIssuance(in lic.TrialIssuanceInput) (*lic.TrialIssuance, error) {
	return recordTrialIssuance(context.Background(), t.tx, in)
}

// FindTrialIssuance returns the most recent trial issuance for the pair.
func (t *postgresTx) FindTrialIssuance(query lic.TrialIssuanceLookup) (*lic.TrialIssuance, error) {
	return findTrialIssuance(context.Background(), t.tx, query)
}

// DeleteTrialIssuance hard-deletes a trial-issuance row inside a tx.
func (t *postgresTx) DeleteTrialIssuance(id string) error {
	return deleteTrialIssuance(context.Background(), t.tx, id)
}

// ---------- Core CRUD (queryable-polymorphic) ----------

// --- License ---

func createLicense(ctx context.Context, q queryable, clk lic.Clock, in lic.LicenseInput) (*lic.License, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.License](ctx, q, scanLicense,
		`INSERT INTO licenses (
			id, scope_id, template_id, licensable_type, licensable_id,
			license_key, status, max_usages, activated_at, expires_at,
			grace_until, meta
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING *`,
		id, in.ScopeID, in.TemplateID, in.LicensableType, in.LicensableID,
		in.LicenseKey, string(in.Status), in.MaxUsages,
		tsOrNull(in.ActivatedAt), tsOrNull(in.ExpiresAt), tsOrNull(in.GraceUntil),
		jsonArg(in.Meta),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getLicense(ctx context.Context, q queryable, id string) (*lic.License, error) {
	return queryOptional[lic.License](ctx, q, scanLicense,
		"SELECT * FROM licenses WHERE id = $1", id)
}

func getLicenseByKey(ctx context.Context, q queryable, licenseKey string) (*lic.License, error) {
	return queryOptional[lic.License](ctx, q, scanLicense,
		"SELECT * FROM licenses WHERE license_key = $1", licenseKey)
}

func findLicensesByLicensable(ctx context.Context, q queryable, query lic.FindByLicensableQuery) ([]lic.License, error) {
	where := []string{"licensable_type = $1", "licensable_id = $2"}
	args := []any{query.Type, query.ID}
	if query.ScopeIDSet {
		if query.ScopeID == nil {
			where = append(where, "scope_id IS NULL")
		} else {
			args = append(args, *query.ScopeID)
			where = append(where, fmt.Sprintf("scope_id = $%d", len(args)))
		}
	}
	sql := "SELECT * FROM licenses WHERE " + strings.Join(where, " AND ") +
		" ORDER BY created_at DESC, id DESC"
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, mapPgError(err)
	}
	defer rows.Close()
	out := make([]lic.License, 0)
	for rows.Next() {
		l, err := scanLicense(rows)
		if err != nil {
			return nil, mapPgError(err)
		}
		out = append(out, *l)
	}
	if err := rows.Err(); err != nil {
		return nil, mapPgError(err)
	}
	return out, nil
}

func listLicenses(ctx context.Context, q queryable, filter lic.LicenseFilter, page lic.PageRequest) (lic.Page[lic.License], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = $%d", *filter.ScopeID)
		}
	}
	if len(filter.Status) > 0 {
		wb.addStringSlice("status", licStatusStrings(filter.Status))
	}
	if filter.LicensableType != nil {
		wb.addParam("licensable_type = $%d", *filter.LicensableType)
	}
	if filter.LicensableID != nil {
		wb.addParam("licensable_id = $%d", *filter.LicensableID)
	}
	if filter.TemplateIDSet {
		if filter.TemplateID == nil {
			wb.add("template_id IS NULL")
		} else {
			wb.addParam("template_id = $%d", *filter.TemplateID)
		}
	}
	return queryPage(ctx, q, scanLicense, extractLicense, "licenses", "created_at", wb, page)
}

func updateLicense(ctx context.Context, q queryable, id string, patch lic.LicensePatch) (*lic.License, error) {
	ub := updateBuilder{}
	if patch.Status != nil {
		ub.set("status", string(*patch.Status))
	}
	if patch.MaxUsages != nil {
		ub.set("max_usages", *patch.MaxUsages)
	}
	if patch.ActivatedAt.Set {
		ub.set("activated_at", tsOrNull(patch.ActivatedAt.Value))
	}
	if patch.ExpiresAt.Set {
		ub.set("expires_at", tsOrNull(patch.ExpiresAt.Value))
	}
	if patch.GraceUntil.Set {
		ub.set("grace_until", tsOrNull(patch.GraceUntil.Value))
	}
	if patch.Meta.Set {
		ub.set("meta", jsonArg(patch.Meta.Value))
	}
	if patch.ScopeID.Set {
		ub.set("scope_id", patch.ScopeID.Value)
	}
	if patch.TemplateID.Set {
		ub.set("template_id", patch.TemplateID.Value)
	}
	row, err := execUpdate(ctx, q, scanLicense, "licenses", id, ub)
	if err != nil {
		return nil, mapPgError(err)
	}
	if row == nil {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return row, nil
}

func deleteLicense(ctx context.Context, q queryable, id string) error {
	var n int
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM license_usages
		 WHERE license_id = $1 AND status = 'active'`, id,
	).Scan(&n); err != nil {
		return mapPgError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"license "+id+" has active usages — revoke them before deleting",
			map[string]any{"id": id, "active_usages": n})
	}
	// Clear revoked usage rows so the RESTRICT FK doesn't block the license delete.
	if _, err := q.Exec(ctx, `DELETE FROM license_usages WHERE license_id = $1`, id); err != nil {
		return mapPgError(err)
	}
	tag, err := q.Exec(ctx, `DELETE FROM licenses WHERE id = $1`, id)
	if err != nil {
		return mapPgError(err)
	}
	if tag.RowsAffected() == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"license not found: "+id, map[string]any{"id": id})
	}
	return nil
}

// --- LicenseScope ---

func createScope(ctx context.Context, q queryable, clk lic.Clock, in lic.LicenseScopeInput) (*lic.LicenseScope, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.LicenseScope](ctx, q, scanScope,
		`INSERT INTO license_scopes (id, slug, name, meta)
		VALUES ($1,$2,$3,$4) RETURNING *`,
		id, in.Slug, in.Name, jsonArg(in.Meta),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getScope(ctx context.Context, q queryable, id string) (*lic.LicenseScope, error) {
	return queryOptional[lic.LicenseScope](ctx, q, scanScope,
		"SELECT * FROM license_scopes WHERE id = $1", id)
}

func getScopeBySlug(ctx context.Context, q queryable, slug string) (*lic.LicenseScope, error) {
	return queryOptional[lic.LicenseScope](ctx, q, scanScope,
		"SELECT * FROM license_scopes WHERE slug = $1", slug)
}

func listScopes(ctx context.Context, q queryable, filter lic.LicenseScopeFilter, page lic.PageRequest) (lic.Page[lic.LicenseScope], error) {
	wb := whereBuilder{}
	if filter.Slug != nil {
		wb.addParam("slug = $%d", *filter.Slug)
	}
	return queryPage(ctx, q, scanScope, extractScope, "license_scopes", "created_at", wb, page)
}

func updateScope(ctx context.Context, q queryable, id string, patch lic.LicenseScopePatch) (*lic.LicenseScope, error) {
	ub := updateBuilder{}
	if patch.Name != nil {
		ub.set("name", *patch.Name)
	}
	if patch.Meta.Set {
		ub.set("meta", jsonArg(patch.Meta.Value))
	}
	row, err := execUpdate(ctx, q, scanScope, "license_scopes", id, ub)
	if err != nil {
		return nil, mapPgError(err)
	}
	if row == nil {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return row, nil
}

func deleteScope(ctx context.Context, q queryable, id string) error {
	var n int
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM licenses WHERE scope_id = $1`, id,
	).Scan(&n); err != nil {
		return mapPgError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"scope "+id+" is referenced by licenses",
			map[string]any{"id": id, "license_refs": n})
	}
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM license_templates WHERE scope_id = $1`, id,
	).Scan(&n); err != nil {
		return mapPgError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"scope "+id+" is referenced by templates",
			map[string]any{"id": id, "template_refs": n})
	}
	tag, err := q.Exec(ctx, `DELETE FROM license_scopes WHERE id = $1`, id)
	if err != nil {
		return mapPgError(err)
	}
	if tag.RowsAffected() == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"scope not found: "+id, map[string]any{"id": id})
	}
	return nil
}

// --- LicenseTemplate ---

func createTemplate(ctx context.Context, q queryable, clk lic.Clock, in lic.LicenseTemplateInput) (*lic.LicenseTemplate, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.LicenseTemplate](ctx, q, scanTemplate,
		`INSERT INTO license_templates (
			id, scope_id, parent_id, name, max_usages, trial_duration_sec,
			trial_cooldown_sec, grace_duration_sec, force_online_after_sec,
			entitlements, meta
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
		id, in.ScopeID, in.ParentID, in.Name, in.MaxUsages,
		in.TrialDurationSec, in.TrialCooldownSec, in.GraceDurationSec,
		in.ForceOnlineAfterSec,
		jsonArg(in.Entitlements), jsonArg(in.Meta),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getTemplate(ctx context.Context, q queryable, id string) (*lic.LicenseTemplate, error) {
	return queryOptional[lic.LicenseTemplate](ctx, q, scanTemplate,
		"SELECT * FROM license_templates WHERE id = $1", id)
}

func listTemplates(ctx context.Context, q queryable, filter lic.LicenseTemplateFilter, page lic.PageRequest) (lic.Page[lic.LicenseTemplate], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = $%d", *filter.ScopeID)
		}
	}
	if filter.Name != nil {
		wb.addParam("name = $%d", *filter.Name)
	}
	if filter.ParentIDSet {
		if filter.ParentID == nil {
			wb.add("parent_id IS NULL")
		} else {
			wb.addParam("parent_id = $%d", *filter.ParentID)
		}
	}
	return queryPage(ctx, q, scanTemplate, extractTemplate, "license_templates", "created_at", wb, page)
}

func updateTemplate(ctx context.Context, q queryable, id string, patch lic.LicenseTemplatePatch) (*lic.LicenseTemplate, error) {
	// Cycle detection on re-parenting.
	if patch.ParentID.Set && patch.ParentID.Value != nil {
		chain, err := walkPgParentChain(ctx, q, *patch.ParentID.Value, id)
		if err != nil {
			return nil, err
		}
		if chain != nil {
			return nil, lic.NewError(lic.CodeTemplateCycle,
				fmt.Sprintf("template parent chain forms a cycle through %s", id),
				map[string]any{"id": id, "chain": chain})
		}
	}
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
	if patch.ParentID.Set {
		ub.set("parent_id", patch.ParentID.Value)
	}
	if patch.ForceOnlineAfterSec.Set {
		ub.set("force_online_after_sec", patch.ForceOnlineAfterSec.Value)
	}
	if patch.TrialCooldownSec.Set {
		ub.set("trial_cooldown_sec", patch.TrialCooldownSec.Value)
	}
	if patch.Entitlements.Set {
		ub.set("entitlements", jsonArg(patch.Entitlements.Value))
	}
	if patch.Meta.Set {
		ub.set("meta", jsonArg(patch.Meta.Value))
	}
	row, err := execUpdate(ctx, q, scanTemplate, "license_templates", id, ub)
	if err != nil {
		return nil, mapPgError(err)
	}
	if row == nil {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return row, nil
}

// walkPgParentChain walks toward the root from startParent and returns the
// visited ids if `forbidden` appears. Nil = no cycle. 64-hop cap.
func walkPgParentChain(ctx context.Context, q queryable, startParent string, forbidden string) ([]string, error) {
	visited := make([]string, 0, 8)
	cursor := startParent
	for range 64 {
		visited = append(visited, cursor)
		if cursor == forbidden {
			return visited, nil
		}
		var parentID *string
		err := q.QueryRow(ctx, "SELECT parent_id FROM license_templates WHERE id = $1", cursor).Scan(&parentID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil
			}
			return nil, mapPgError(err)
		}
		if parentID == nil {
			return nil, nil
		}
		cursor = *parentID
	}
	return nil, nil
}

func deleteTemplate(ctx context.Context, q queryable, id string) error {
	var n int
	if err := q.QueryRow(ctx,
		`SELECT COUNT(*) FROM licenses WHERE template_id = $1`, id,
	).Scan(&n); err != nil {
		return mapPgError(err)
	}
	if n > 0 {
		return lic.NewError(lic.CodeUniqueConstraintViolation,
			"template "+id+" is referenced by licenses",
			map[string]any{"id": id, "license_refs": n})
	}
	tag, err := q.Exec(ctx, `DELETE FROM license_templates WHERE id = $1`, id)
	if err != nil {
		return mapPgError(err)
	}
	if tag.RowsAffected() == 0 {
		return lic.NewError(lic.CodeLicenseNotFound,
			"template not found: "+id, map[string]any{"id": id})
	}
	return nil
}

// --- LicenseUsage ---

func createUsage(ctx context.Context, q queryable, clk lic.Clock, in lic.LicenseUsageInput, inTx bool) (*lic.LicenseUsage, error) {
	// Seat check: take a row lock on the parent license so concurrent
	// registrations serialize. Only done inside a transaction — outside
	// one, FOR UPDATE is valid but the lock is released at statement end.
	if inTx {
		_, err := q.Exec(ctx, "SELECT id FROM licenses WHERE id = $1 FOR UPDATE", in.LicenseID)
		if err != nil {
			return nil, err
		}
	}
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.LicenseUsage](ctx, q, scanUsage,
		`INSERT INTO license_usages (
			id, license_id, fingerprint, status, registered_at, revoked_at, client_meta
		) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
		id, in.LicenseID, in.Fingerprint, string(in.Status),
		tsVal(in.RegisteredAt), tsOrNull(in.RevokedAt),
		jsonArg(in.ClientMeta),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getUsage(ctx context.Context, q queryable, id string) (*lic.LicenseUsage, error) {
	return queryOptional[lic.LicenseUsage](ctx, q, scanUsage,
		"SELECT * FROM license_usages WHERE id = $1", id)
}

func listUsages(ctx context.Context, q queryable, filter lic.LicenseUsageFilter, page lic.PageRequest) (lic.Page[lic.LicenseUsage], error) {
	wb := whereBuilder{}
	if filter.LicenseID != nil {
		wb.addParam("license_id = $%d", *filter.LicenseID)
	}
	if filter.Fingerprint != nil {
		wb.addParam("fingerprint = $%d", *filter.Fingerprint)
	}
	if len(filter.Status) > 0 {
		wb.addStringSlice("status", usageStatusStrings(filter.Status))
	}
	return queryPage(ctx, q, scanUsage, extractUsage, "license_usages", "created_at", wb, page)
}

func updateUsage(ctx context.Context, q queryable, id string, patch lic.LicenseUsagePatch) (*lic.LicenseUsage, error) {
	ub := updateBuilder{}
	if patch.Status != nil {
		ub.set("status", string(*patch.Status))
	}
	if patch.RevokedAt.Set {
		ub.set("revoked_at", tsOrNull(patch.RevokedAt.Value))
	}
	if patch.ClientMeta.Set {
		ub.set("client_meta", jsonArg(patch.ClientMeta.Value))
	}
	row, err := execUpdate(ctx, q, scanUsage, "license_usages", id, ub)
	if err != nil {
		return nil, mapPgError(err)
	}
	if row == nil {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return row, nil
}

// --- LicenseKey ---

func createKey(ctx context.Context, q queryable, clk lic.Clock, in lic.LicenseKeyInput) (*lic.LicenseKey, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.LicenseKey](ctx, q, scanKey,
		`INSERT INTO license_keys (
			id, scope_id, kid, alg, role, state, public_pem, private_pem_enc,
			rotated_from, rotated_at, not_before, not_after, meta
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
		id, in.ScopeID, in.Kid, string(in.Alg), string(in.Role), string(in.State),
		in.PublicPem, in.PrivatePemEnc,
		in.RotatedFrom, tsOrNull(in.RotatedAt),
		tsVal(in.NotBefore), tsOrNull(in.NotAfter),
		jsonArg(in.Meta),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getKey(ctx context.Context, q queryable, id string) (*lic.LicenseKey, error) {
	return queryOptional[lic.LicenseKey](ctx, q, scanKey,
		"SELECT * FROM license_keys WHERE id = $1", id)
}

func getKeyByKid(ctx context.Context, q queryable, kid string) (*lic.LicenseKey, error) {
	return queryOptional[lic.LicenseKey](ctx, q, scanKey,
		"SELECT * FROM license_keys WHERE kid = $1", kid)
}

func listKeys(ctx context.Context, q queryable, filter lic.LicenseKeyFilter, page lic.PageRequest) (lic.Page[lic.LicenseKey], error) {
	wb := whereBuilder{}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			wb.add("scope_id IS NULL")
		} else {
			wb.addParam("scope_id = $%d", *filter.ScopeID)
		}
	}
	if filter.Kid != nil {
		wb.addParam("kid = $%d", *filter.Kid)
	}
	if filter.Alg != nil {
		wb.addParam("alg = $%d", string(*filter.Alg))
	}
	if filter.Role != nil {
		wb.addParam("role = $%d", string(*filter.Role))
	}
	if filter.State != nil {
		wb.addParam("state = $%d", string(*filter.State))
	}
	return queryPage(ctx, q, scanKey, extractKey, "license_keys", "created_at", wb, page)
}

func updateKey(ctx context.Context, q queryable, id string, patch lic.LicenseKeyPatch) (*lic.LicenseKey, error) {
	ub := updateBuilder{}
	if patch.State != nil {
		ub.set("state", string(*patch.State))
	}
	if patch.RotatedFrom.Set {
		ub.set("rotated_from", patch.RotatedFrom.Value)
	}
	if patch.RotatedAt.Set {
		ub.set("rotated_at", tsOrNull(patch.RotatedAt.Value))
	}
	if patch.NotAfter.Set {
		ub.set("not_after", tsOrNull(patch.NotAfter.Value))
	}
	if patch.Meta.Set {
		ub.set("meta", jsonArg(patch.Meta.Value))
	}
	row, err := execUpdate(ctx, q, scanKey, "license_keys", id, ub)
	if err != nil {
		return nil, mapPgError(err)
	}
	if row == nil {
		return nil, lic.NewError(lic.CodeUniqueConstraintViolation, "pk: "+id,
			map[string]any{"constraint": "pk"})
	}
	return row, nil
}

// --- AuditLog ---

func appendAudit(ctx context.Context, q queryable, clk lic.Clock, in lic.AuditLogInput) (*lic.AuditLogEntry, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.AuditLogEntry](ctx, q, scanAudit,
		`INSERT INTO audit_logs (
			id, license_id, scope_id, actor, event, prior_state, new_state, occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
		id, in.LicenseID, in.ScopeID, in.Actor, in.Event,
		jsonArgNullable(in.PriorState), jsonArgNullable(in.NewState),
		tsVal(in.OccurredAt),
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func getAudit(ctx context.Context, q queryable, id string) (*lic.AuditLogEntry, error) {
	return queryOptional[lic.AuditLogEntry](ctx, q, scanAudit,
		"SELECT * FROM audit_logs WHERE id = $1", id)
}

func listAudit(ctx context.Context, q queryable, filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	needsCustomPath := filter.LicensableType != nil ||
		filter.LicensableID != nil ||
		len(filter.Events) > 0 ||
		filter.Actor != nil ||
		filter.Since != nil ||
		filter.Until != nil
	if !needsCustomPath {
		wb := whereBuilder{}
		if filter.LicenseIDSet {
			if filter.LicenseID == nil {
				wb.add("license_id IS NULL")
			} else {
				wb.addParam("license_id = $%d", *filter.LicenseID)
			}
		}
		if filter.ScopeIDSet {
			if filter.ScopeID == nil {
				wb.add("scope_id IS NULL")
			} else {
				wb.addParam("scope_id = $%d", *filter.ScopeID)
			}
		}
		if filter.Event != nil {
			wb.addParam("event = $%d", *filter.Event)
		}
		return queryPage(ctx, q, scanAudit, extractAudit, "audit_logs", "occurred_at", wb, page)
	}
	return listAuditExtended(ctx, q, filter, page)
}

func listAuditExtended(ctx context.Context, q queryable, filter lic.AuditLogFilter, page lic.PageRequest) (lic.Page[lic.AuditLogEntry], error) {
	conds := []string{"1=1"}
	args := []any{}
	from := "audit_logs a"
	addParam := func(predicate string, value any) {
		args = append(args, value)
		conds = append(conds, fmt.Sprintf(predicate, len(args)))
	}
	if filter.LicenseIDSet {
		if filter.LicenseID == nil {
			conds = append(conds, "a.license_id IS NULL")
		} else {
			addParam("a.license_id = $%d", *filter.LicenseID)
		}
	}
	if filter.ScopeIDSet {
		if filter.ScopeID == nil {
			conds = append(conds, "a.scope_id IS NULL")
		} else {
			addParam("a.scope_id = $%d", *filter.ScopeID)
		}
	}
	if filter.Event != nil && len(filter.Events) == 0 {
		addParam("a.event = $%d", *filter.Event)
	}
	if len(filter.Events) > 0 {
		placeholders := make([]string, len(filter.Events))
		for i, e := range filter.Events {
			args = append(args, e)
			placeholders[i] = fmt.Sprintf("$%d", len(args))
		}
		conds = append(conds, "a.event IN ("+strings.Join(placeholders, ",")+")")
	}
	if filter.Actor != nil {
		addParam("a.actor = $%d", *filter.Actor)
	}
	if filter.Since != nil {
		addParam("a.occurred_at >= $%d", *filter.Since)
	}
	if filter.Until != nil {
		addParam("a.occurred_at < $%d", *filter.Until)
	}
	if filter.LicensableType != nil || filter.LicensableID != nil {
		from = "audit_logs a INNER JOIN licenses l ON l.id = a.license_id"
		if filter.LicensableType != nil {
			addParam("l.licensable_type = $%d", *filter.LicensableType)
		}
		if filter.LicensableID != nil {
			addParam("l.licensable_id = $%d", *filter.LicensableID)
		}
	}
	limit := max(1, min(page.Limit, 500))
	cursor, hasCursor := lic.DecodeCursor(page.Cursor)
	if hasCursor {
		args = append(args, cursor.CreatedAt, cursor.ID)
		conds = append(conds, fmt.Sprintf("(a.occurred_at, a.id) < ($%d, $%d)", len(args)-1, len(args)))
	}
	query := fmt.Sprintf(
		"SELECT a.* FROM %s WHERE %s ORDER BY a.occurred_at DESC, a.id DESC LIMIT %d",
		from, strings.Join(conds, " AND "), limit+1,
	)
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return lic.Page[lic.AuditLogEntry]{}, mapPgError(err)
	}
	defer rows.Close()
	items := make([]lic.AuditLogEntry, 0)
	for rows.Next() {
		row, err := scanAudit(rows)
		if err != nil {
			return lic.Page[lic.AuditLogEntry]{}, mapPgError(err)
		}
		items = append(items, *row)
	}
	if err := rows.Err(); err != nil {
		return lic.Page[lic.AuditLogEntry]{}, mapPgError(err)
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	cur := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		cur = lic.EncodeCursor(lic.CursorTuple{CreatedAt: last.OccurredAt, ID: last.ID})
	}
	return lic.Page[lic.AuditLogEntry]{Items: items, Cursor: cur}, nil
}

// --- TrialIssuance ---

func recordTrialIssuance(ctx context.Context, q queryable, in lic.TrialIssuanceInput) (*lic.TrialIssuance, error) {
	id := lic.NewUUIDv7()
	row, err := queryOne[lic.TrialIssuance](ctx, q, scanTrialIssuance,
		`INSERT INTO trial_issuances (id, template_id, fingerprint_hash)
		 VALUES ($1,$2,$3) RETURNING *`,
		id, in.TemplateID, in.FingerprintHash,
	)
	if err != nil {
		return nil, mapPgError(err)
	}
	return row, nil
}

func findTrialIssuance(ctx context.Context, q queryable, query lic.TrialIssuanceLookup) (*lic.TrialIssuance, error) {
	if query.TemplateID == nil {
		return queryOptional[lic.TrialIssuance](ctx, q, scanTrialIssuance,
			`SELECT * FROM trial_issuances
			  WHERE template_id IS NULL AND fingerprint_hash = $1
			  ORDER BY issued_at DESC LIMIT 1`,
			query.FingerprintHash)
	}
	return queryOptional[lic.TrialIssuance](ctx, q, scanTrialIssuance,
		`SELECT * FROM trial_issuances
		  WHERE template_id = $1 AND fingerprint_hash = $2
		  ORDER BY issued_at DESC LIMIT 1`,
		*query.TemplateID, query.FingerprintHash)
}

func deleteTrialIssuance(ctx context.Context, q queryable, id string) error {
	_, err := q.Exec(ctx, `DELETE FROM trial_issuances WHERE id = $1`, id)
	if err != nil {
		return mapPgError(err)
	}
	return nil
}

func scanTrialIssuance(rows pgx.Rows) (*lic.TrialIssuance, error) {
	var (
		ti       lic.TrialIssuance
		issuedAt time.Time
	)
	if err := rows.Scan(&ti.ID, &ti.TemplateID, &ti.FingerprintHash, &issuedAt); err != nil {
		return nil, err
	}
	ti.IssuedAt = isoFromTime(issuedAt)
	return &ti, nil
}

// ---------- Row scanners ----------

// isoFromTime converts a Postgres timestamptz (Go time.Time) into the
// core's ISO-8601 string with microsecond precision and a trailing Z
// (UTC). Matches TS's isoFromMs but with µs precision.
func isoFromTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

func isoFromTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := isoFromTime(*t)
	return &s
}

func scanLicense(rows pgx.Rows) (*lic.License, error) {
	var (
		r                                  lic.License
		activatedAt, expiresAt, graceUntil *time.Time
		createdAt, updatedAt               time.Time
		metaJSON                           []byte
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.TemplateID,
		&r.LicensableType, &r.LicensableID,
		&r.LicenseKey, &r.Status, &r.MaxUsages,
		&activatedAt, &expiresAt, &graceUntil,
		&metaJSON, &createdAt, &updatedAt,
		// v0002 column appended via ALTER TABLE.
		&r.IsTrial,
	)
	if err != nil {
		return nil, err
	}
	r.ActivatedAt = isoFromTimePtr(activatedAt)
	r.ExpiresAt = isoFromTimePtr(expiresAt)
	r.GraceUntil = isoFromTimePtr(graceUntil)
	r.Meta = jsonFromBytes(metaJSON)
	r.CreatedAt = isoFromTime(createdAt)
	r.UpdatedAt = isoFromTime(updatedAt)
	return &r, nil
}

func scanScope(rows pgx.Rows) (*lic.LicenseScope, error) {
	var (
		r                    lic.LicenseScope
		metaJSON             []byte
		createdAt, updatedAt time.Time
	)
	err := rows.Scan(&r.ID, &r.Slug, &r.Name, &metaJSON, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	r.Meta = jsonFromBytes(metaJSON)
	r.CreatedAt = isoFromTime(createdAt)
	r.UpdatedAt = isoFromTime(updatedAt)
	return &r, nil
}

func scanTemplate(rows pgx.Rows) (*lic.LicenseTemplate, error) {
	var (
		r                    lic.LicenseTemplate
		entJSON, metaJSON    []byte
		createdAt, updatedAt time.Time
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.Name,
		&r.MaxUsages, &r.TrialDurationSec, &r.GraceDurationSec,
		&r.ForceOnlineAfterSec,
		&entJSON, &metaJSON, &createdAt, &updatedAt,
		// v0002 columns appended via ALTER TABLE.
		&r.ParentID, &r.TrialCooldownSec,
	)
	if err != nil {
		return nil, err
	}
	r.Entitlements = jsonFromBytes(entJSON)
	r.Meta = jsonFromBytes(metaJSON)
	r.CreatedAt = isoFromTime(createdAt)
	r.UpdatedAt = isoFromTime(updatedAt)
	return &r, nil
}

func scanUsage(rows pgx.Rows) (*lic.LicenseUsage, error) {
	var (
		r                    lic.LicenseUsage
		registeredAt         time.Time
		revokedAt            *time.Time
		clientJSON           []byte
		createdAt, updatedAt time.Time
	)
	err := rows.Scan(
		&r.ID, &r.LicenseID, &r.Fingerprint, &r.Status,
		&registeredAt, &revokedAt, &clientJSON,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	r.RegisteredAt = isoFromTime(registeredAt)
	r.RevokedAt = isoFromTimePtr(revokedAt)
	r.ClientMeta = jsonFromBytes(clientJSON)
	r.CreatedAt = isoFromTime(createdAt)
	r.UpdatedAt = isoFromTime(updatedAt)
	return &r, nil
}

func scanKey(rows pgx.Rows) (*lic.LicenseKey, error) {
	var (
		r                    lic.LicenseKey
		rotatedAt            *time.Time
		notBefore            time.Time
		notAfter             *time.Time
		metaJSON             []byte
		createdAt, updatedAt time.Time
	)
	err := rows.Scan(
		&r.ID, &r.ScopeID, &r.Kid, &r.Alg, &r.Role, &r.State,
		&r.PublicPem, &r.PrivatePemEnc,
		&r.RotatedFrom, &rotatedAt,
		&notBefore, &notAfter,
		&metaJSON, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	r.RotatedAt = isoFromTimePtr(rotatedAt)
	r.NotBefore = isoFromTime(notBefore)
	r.NotAfter = isoFromTimePtr(notAfter)
	r.Meta = jsonFromBytes(metaJSON)
	r.CreatedAt = isoFromTime(createdAt)
	r.UpdatedAt = isoFromTime(updatedAt)
	return &r, nil
}

func scanAudit(rows pgx.Rows) (*lic.AuditLogEntry, error) {
	var (
		r                  lic.AuditLogEntry
		priorJSON, newJSON []byte
		occurredAt         time.Time
	)
	err := rows.Scan(
		&r.ID, &r.LicenseID, &r.ScopeID,
		&r.Actor, &r.Event,
		&priorJSON, &newJSON,
		&occurredAt,
	)
	if err != nil {
		return nil, err
	}
	r.PriorState = jsonFromBytesNullable(priorJSON)
	r.NewState = jsonFromBytesNullable(newJSON)
	r.OccurredAt = isoFromTime(occurredAt)
	return &r, nil
}

// ---------- Cursor extractors ----------

func extractLicense(r *lic.License) (string, string)          { return r.CreatedAt, r.ID }
func extractScope(r *lic.LicenseScope) (string, string)       { return r.CreatedAt, r.ID }
func extractTemplate(r *lic.LicenseTemplate) (string, string) { return r.CreatedAt, r.ID }
func extractUsage(r *lic.LicenseUsage) (string, string)       { return r.CreatedAt, r.ID }
func extractKey(r *lic.LicenseKey) (string, string)           { return r.CreatedAt, r.ID }
func extractAudit(r *lic.AuditLogEntry) (string, string)      { return r.OccurredAt, r.ID }

// ---------- Query helpers ----------

type scanFunc[T any] func(pgx.Rows) (*T, error)

// queryOne executes sql and scans exactly one row.
func queryOne[T any](ctx context.Context, q queryable, scan scanFunc[T], sql string, args ...any) (*T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("expected exactly one row")
	}
	return scan(rows)
}

// queryOptional executes sql and returns nil if no rows.
func queryOptional[T any](ctx context.Context, q queryable, scan scanFunc[T], sql string, args ...any) (*T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scan(rows)
}

// queryAll collects all rows from a query.
func queryAll[T any](ctx context.Context, q queryable, scan scanFunc[T], sql string, args ...any) ([]*T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*T
	for rows.Next() {
		row, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ---------- Pagination ----------

// tsIDFunc extracts the ordering timestamp and id from a row for cursor
// encoding. For most entities this is (created_at, id); for AuditLog
// it's (occurred_at, id).
type tsIDFunc[T any] func(row *T) (ts string, id string)

// queryPage builds and executes a paginated list query.
// tsCol is the timestamp column for ordering (created_at or occurred_at).
func queryPage[T any](
	ctx context.Context, q queryable, scan scanFunc[T], extract tsIDFunc[T],
	table, tsCol string, wb whereBuilder, page lic.PageRequest,
) (lic.Page[T], error) {
	limit := max(1, min(page.Limit, 500))

	cursor, ok := lic.DecodeCursor(page.Cursor)
	if ok {
		wb.addParam2(fmt.Sprintf("(%s, id) < ($%%d, $%%d)", tsCol), cursor.CreatedAt, cursor.ID)
	}

	where := wb.build()
	sql := fmt.Sprintf("SELECT * FROM %s WHERE %s ORDER BY %s DESC, id DESC LIMIT %d",
		table, where, tsCol, limit+1)

	items, err := queryAll(ctx, q, scan, sql, wb.params...)
	if err != nil {
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

// ---------- WHERE builder ----------

type whereBuilder struct {
	clauses []string
	params  []any
}

func (w *whereBuilder) add(clause string) {
	w.clauses = append(w.clauses, clause)
}

func (w *whereBuilder) addParam(template string, val any) {
	w.params = append(w.params, val)
	w.clauses = append(w.clauses, fmt.Sprintf(template, len(w.params)))
}

func (w *whereBuilder) addParam2(template string, val1, val2 any) {
	w.params = append(w.params, val1, val2)
	n := len(w.params)
	w.clauses = append(w.clauses, fmt.Sprintf(template, n-1, n))
}

func (w *whereBuilder) addStringSlice(col string, vals []string) {
	w.params = append(w.params, vals)
	w.clauses = append(w.clauses, fmt.Sprintf("%s = ANY($%d)", col, len(w.params)))
}

func (w *whereBuilder) build() string {
	if len(w.clauses) == 0 {
		return "1=1"
	}
	return strings.Join(w.clauses, " AND ")
}

// ---------- UPDATE builder ----------

type updateBuilder struct {
	cols   []string
	params []any
}

func (u *updateBuilder) set(col string, val any) {
	u.params = append(u.params, val)
	u.cols = append(u.cols, fmt.Sprintf("%s = $%d", col, len(u.params)))
}

func (u *updateBuilder) isEmpty() bool { return len(u.cols) == 0 }

func execUpdate[T any](
	ctx context.Context, q queryable, scan scanFunc[T],
	table, id string, ub updateBuilder,
) (*T, error) {
	if ub.isEmpty() {
		// Empty patch — just bump updated_at.
		sql := fmt.Sprintf("UPDATE %s SET updated_at = now() WHERE id = $1 RETURNING *", table)
		return queryOptional(ctx, q, scan, sql, id)
	}
	ub.params = append(ub.params, id)
	sql := fmt.Sprintf("UPDATE %s SET %s, updated_at = now() WHERE id = $%d RETURNING *",
		table, strings.Join(ub.cols, ", "), len(ub.params))
	return queryOptional(ctx, q, scan, sql, ub.params...)
}

// ---------- Type converters ----------

// tsOrNull converts a nullable ISO string to a *time.Time for pg.
func tsOrNull(s *string) *time.Time {
	if s == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return nil
	}
	return &t
}

// tsVal converts a non-nullable ISO string to time.Time.
func tsVal(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// jsonArg marshals a map to []byte for jsonb. Nil maps become {}.
func jsonArg(m map[string]any) []byte {
	if m == nil {
		return []byte("{}")
	}
	b, _ := json.Marshal(m)
	return b
}

// jsonArgNullable marshals a map to []byte, or returns nil for SQL NULL.
func jsonArgNullable(m map[string]any) *[]byte {
	if m == nil {
		return nil
	}
	b, _ := json.Marshal(m)
	return &b
}

// jsonFromBytes unmarshals jsonb bytes into map. Returns {} on nil/empty.
func jsonFromBytes(b []byte) map[string]any {
	if len(b) == 0 {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return map[string]any{}
	}
	return m
}

// jsonFromBytesNullable returns nil for SQL NULL, otherwise unmarshals.
func jsonFromBytesNullable(b []byte) map[string]any {
	if b == nil {
		return nil
	}
	return jsonFromBytes(b)
}

// licStatusStrings converts []LicenseStatus to []string for ANY($N).
func licStatusStrings(statuses []lic.LicenseStatus) []string {
	out := make([]string, len(statuses))
	for i, s := range statuses {
		out[i] = string(s)
	}
	return out
}

// usageStatusStrings converts []UsageStatus to []string for ANY($N).
func usageStatusStrings(statuses []lic.UsageStatus) []string {
	out := make([]string, len(statuses))
	for i, s := range statuses {
		out[i] = string(s)
	}
	return out
}
