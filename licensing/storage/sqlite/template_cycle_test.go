package sqlite_test

import (
	"errors"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/sqlite"
)

func freshSqlite(t *testing.T) *sqlite.Storage {
	t.Helper()
	s, err := sqlite.Open(":memory:", sqlite.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := sqlite.ApplyMigrations(s.DB()); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return s
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

func TestSqlite_TemplateCycle_Direct(t *testing.T) {
	s := freshSqlite(t)
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

func TestSqlite_TemplateCycle_Indirect(t *testing.T) {
	s := freshSqlite(t)
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

func TestSqlite_TemplateCycle_AllowsValidReParent(t *testing.T) {
	s := freshSqlite(t)
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
		t.Fatalf("expected nil ParentID, got %v", detached.ParentID)
	}
}

func TestSqlite_TemplateFilter_ParentID(t *testing.T) {
	s := freshSqlite(t)
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
