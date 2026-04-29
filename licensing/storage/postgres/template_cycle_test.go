package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/postgres"
)

func freshPgStorage(t *testing.T) *postgres.Storage {
	t.Helper()
	dsn := os.Getenv("LICENSING_PG_URL")
	if dsn == "" {
		t.Skip("LICENSING_PG_URL not set")
	}
	masterPool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("master pool: %v", err)
	}
	t.Cleanup(masterPool.Close)
	schema := "tcyc_" + randomSchema()
	if _, err := masterPool.Exec(context.Background(), fmt.Sprintf(`CREATE SCHEMA %q`, schema)); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = masterPool.Exec(context.Background(), fmt.Sprintf(`DROP SCHEMA %q CASCADE`, schema))
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, fmt.Sprintf(`SET search_path TO %q, public`, schema))
		return err
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := postgres.ApplyMigrations(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return postgres.New(pool, postgres.Options{})
}

func tmplInput(name string, parentID *string) lic.LicenseTemplateInput {
	return lic.LicenseTemplateInput{
		ScopeID:             nil,
		ParentID:            parentID,
		ForceOnlineAfterSec: nil,
		TrialCooldownSec:    nil,
		Entitlements:        map[string]any{},
		Meta:                map[string]any{},
		Name:                name,
		MaxUsages:           5,
		TrialDurationSec:    0,
		GraceDurationSec:    0,
	}
}

func TestPostgres_TemplateCycle_Direct(t *testing.T) {
	s := freshPgStorage(t)
	a, err := s.CreateTemplate(tmplInput("a", nil))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateTemplate(a.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: &a.ID},
	})
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeTemplateCycle {
		t.Fatalf("expected CodeTemplateCycle, got %v", err)
	}
}

func TestPostgres_TemplateCycle_Indirect(t *testing.T) {
	s := freshPgStorage(t)
	a, _ := s.CreateTemplate(tmplInput("a", nil))
	b, _ := s.CreateTemplate(tmplInput("b", &a.ID))
	c, _ := s.CreateTemplate(tmplInput("c", &b.ID))
	_, err := s.UpdateTemplate(a.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: &c.ID},
	})
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeTemplateCycle {
		t.Fatalf("expected CodeTemplateCycle, got %v", err)
	}
}

func TestPostgres_TemplateCycle_AllowsValidReParent(t *testing.T) {
	s := freshPgStorage(t)
	r1, _ := s.CreateTemplate(tmplInput("r1", nil))
	r2, _ := s.CreateTemplate(tmplInput("r2", nil))
	child, _ := s.CreateTemplate(tmplInput("child", &r1.ID))
	moved, err := s.UpdateTemplate(child.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: &r2.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.ParentID == nil || *moved.ParentID != r2.ID {
		t.Fatalf("re-parent failed")
	}
	detached, err := s.UpdateTemplate(child.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if detached.ParentID != nil {
		t.Fatalf("expected nil ParentID")
	}
}

func TestPostgres_TemplateFilter_ParentID(t *testing.T) {
	s := freshPgStorage(t)
	r, _ := s.CreateTemplate(tmplInput("root", nil))
	_, _ = s.CreateTemplate(tmplInput("c1", &r.ID))
	_, _ = s.CreateTemplate(tmplInput("c2", &r.ID))

	roots, err := s.ListTemplates(
		lic.LicenseTemplateFilter{ParentIDSet: true, ParentID: nil},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots.Items) != 1 {
		t.Fatalf("expected 1 root, got %d", len(roots.Items))
	}
	children, err := s.ListTemplates(
		lic.LicenseTemplateFilter{ParentIDSet: true, ParentID: &r.ID},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(children.Items) != 2 {
		t.Fatalf("expected 2 children, got %d", len(children.Items))
	}
}
