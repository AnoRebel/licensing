package memory_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

func licInputAudit(scopeID *string, lt, lid, key string) lic.LicenseInput {
	return lic.LicenseInput{
		ScopeID:        scopeID,
		LicensableType: lt,
		LicensableID:   lid,
		LicenseKey:     key,
		Status:         lic.LicenseStatusActive,
		MaxUsages:      5,
		Meta:           map[string]any{},
	}
}

func TestMemory_AuditFilter_EventsArray(t *testing.T) {
	s := memory.New(memory.Options{})
	l, _ := s.CreateLicense(licInputAudit(nil, "User", "u1", "LIC-AUD-1"))
	for _, ev := range []string{"license.created", "license.refreshed", "usage.registered"} {
		_, err := s.AppendAudit(lic.AuditLogInput{
			LicenseID:  &l.ID,
			Actor:      "system",
			Event:      ev,
			OccurredAt: "2026-04-01T00:00:00.000000Z",
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListAudit(
		lic.AuditLogFilter{Events: []string{"license.created", "license.refreshed"}},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("expected 2 events, got %d", len(page.Items))
	}
}

func TestMemory_AuditFilter_Actor(t *testing.T) {
	s := memory.New(memory.Options{})
	l, _ := s.CreateLicense(licInputAudit(nil, "User", "u1", "LIC-AUD-2"))
	_, _ = s.AppendAudit(lic.AuditLogInput{
		LicenseID: &l.ID, Actor: "system", Event: "a", OccurredAt: "2026-04-01T00:00:00.000000Z",
	})
	_, _ = s.AppendAudit(lic.AuditLogInput{
		LicenseID: &l.ID, Actor: "admin", Event: "b", OccurredAt: "2026-04-02T00:00:00.000000Z",
	})
	admin := "admin"
	page, err := s.ListAudit(
		lic.AuditLogFilter{Actor: &admin},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 admin event, got %d", len(page.Items))
	}
}

func TestMemory_AuditFilter_TimeWindow(t *testing.T) {
	s := memory.New(memory.Options{})
	l, _ := s.CreateLicense(licInputAudit(nil, "User", "u1", "LIC-AUD-3"))
	timestamps := []string{
		"2026-03-31T12:00:00.000000Z",
		"2026-04-01T00:00:00.000000Z",
		"2026-04-15T00:00:00.000000Z",
		"2026-05-01T00:00:00.000000Z",
	}
	for _, ts := range timestamps {
		_, _ = s.AppendAudit(lic.AuditLogInput{
			LicenseID: &l.ID, Actor: "system", Event: "e", OccurredAt: ts,
		})
	}
	since := "2026-04-01T00:00:00.000000Z"
	until := "2026-05-01T00:00:00.000000Z"
	page, err := s.ListAudit(
		lic.AuditLogFilter{Since: &since, Until: &until},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("expected 2 in-range events, got %d", len(page.Items))
	}
}

func TestMemory_AuditFilter_Licensable(t *testing.T) {
	s := memory.New(memory.Options{})
	l1, _ := s.CreateLicense(licInputAudit(nil, "User", "u1", "LIC-AUD-X"))
	l2, _ := s.CreateLicense(licInputAudit(nil, "User", "u2", "LIC-AUD-Y"))
	_, _ = s.AppendAudit(lic.AuditLogInput{
		LicenseID: &l1.ID, Actor: "system", Event: "license.created",
		OccurredAt: "2026-04-01T00:00:00.000000Z",
	})
	_, _ = s.AppendAudit(lic.AuditLogInput{
		LicenseID: &l2.ID, Actor: "system", Event: "license.created",
		OccurredAt: "2026-04-02T00:00:00.000000Z",
	})
	lt := "User"
	lid := "u1"
	page, err := s.ListAudit(
		lic.AuditLogFilter{LicensableType: &lt, LicensableID: &lid},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 u1 event, got %d", len(page.Items))
	}
	if page.Items[0].LicenseID == nil || *page.Items[0].LicenseID != l1.ID {
		t.Fatal("wrong license id matched")
	}
}
