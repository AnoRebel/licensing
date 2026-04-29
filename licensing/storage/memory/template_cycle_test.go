package memory_test

import (
	"errors"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

// Mirrors typescript/tests/storage-memory/template-cycle.test.ts.

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

func TestMemory_TemplateCycle_Direct(t *testing.T) {
	s := memory.New(memory.Options{})
	a, err := s.CreateTemplate(tmplInput("a", nil))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateTemplate(a.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: &a.ID},
	})
	if err == nil {
		t.Fatal("expected TemplateCycle error")
	}
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeTemplateCycle {
		t.Fatalf("expected CodeTemplateCycle, got %v", err)
	}
}

func TestMemory_TemplateCycle_Indirect(t *testing.T) {
	s := memory.New(memory.Options{})
	a, _ := s.CreateTemplate(tmplInput("a", nil))
	b, _ := s.CreateTemplate(tmplInput("b", &a.ID))
	c, _ := s.CreateTemplate(tmplInput("c", &b.ID))
	_, err := s.UpdateTemplate(a.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: &c.ID},
	})
	if err == nil {
		t.Fatal("expected TemplateCycle error")
	}
	var lerr *lic.Error
	if !errors.As(err, &lerr) || lerr.Code != lic.CodeTemplateCycle {
		t.Fatalf("expected CodeTemplateCycle, got %v", err)
	}
}

func TestMemory_TemplateCycle_AllowsValidReParent(t *testing.T) {
	s := memory.New(memory.Options{})
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
		t.Fatalf("re-parent failed: got %v want %s", moved.ParentID, r2.ID)
	}
	// Detach to nil.
	detached, err := s.UpdateTemplate(child.ID, lic.LicenseTemplatePatch{
		ParentID: lic.OptString{Set: true, Value: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if detached.ParentID != nil {
		t.Fatalf("expected nil parent_id, got %v", detached.ParentID)
	}
}

func TestMemory_TemplateFilter_ParentID(t *testing.T) {
	s := memory.New(memory.Options{})
	root, _ := s.CreateTemplate(tmplInput("root", nil))
	_, _ = s.CreateTemplate(tmplInput("c1", &root.ID))
	_, _ = s.CreateTemplate(tmplInput("c2", &root.ID))

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
		lic.LicenseTemplateFilter{ParentIDSet: true, ParentID: &root.ID},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(children.Items) != 2 {
		t.Fatalf("expected 2 children, got %d", len(children.Items))
	}
}
