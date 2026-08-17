package licensing_test

import (
	"testing"
	"time"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

type sweepClock struct{ now string }

func (c *sweepClock) NowISO() string { return c.now }

// A seat that stops heartbeating must become reclaimable, and one that
// keeps reporting must not — the whole point of last_seen_at.
func TestSweepInactiveUsages(t *testing.T) {
	clk := &sweepClock{now: "2026-06-01T00:00:00.000000Z"}
	st := memory.New(memory.Options{Clock: clk})

	lc, err := st.CreateLicense(lic.LicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: "LIC-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH",
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
	})
	if err != nil {
		t.Fatal(err)
	}

	mk := func(fp, seen string) *lic.LicenseUsage {
		u, err := st.CreateUsage(lic.LicenseUsageInput{
			LicenseID: lc.ID, Fingerprint: fp,
			Status: lic.UsageStatusActive, RegisteredAt: seen,
		})
		if err != nil {
			t.Fatal(err)
		}
		return u
	}

	fresh := mk("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
		"2026-05-31T23:00:00.000000Z") // 1h ago
	stale := mk("b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
		"2026-04-01T00:00:00.000000Z") // ~2 months ago

	// A new usage inherits its liveness clock from registration.
	if fresh.LastSeenAt != "2026-05-31T23:00:00.000000Z" {
		t.Fatalf("last_seen_at should default to registered_at, got %q", fresh.LastSeenAt)
	}

	// Dry run must report without mutating.
	dry, err := lic.SweepInactiveUsages(st, clk, lic.SweepInactiveUsagesOptions{
		InactiveFor: 30 * 24 * time.Hour, DryRun: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(dry.Stale) != 1 || dry.Stale[0] != stale.ID {
		t.Fatalf("dry run should flag exactly the stale seat, got %v", dry.Stale)
	}
	if len(dry.Revoked) != 0 {
		t.Fatalf("dry run must not revoke anything, got %v", dry.Revoked)
	}
	if got, _ := st.GetUsage(stale.ID); got.Status != lic.UsageStatusActive {
		t.Fatal("dry run mutated the seat")
	}

	// Live run revokes only the stale seat.
	res, err := lic.SweepInactiveUsages(st, clk, lic.SweepInactiveUsagesOptions{
		InactiveFor: 30 * 24 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Revoked) != 1 || res.Revoked[0] != stale.ID {
		t.Fatalf("expected only the stale seat revoked, got %v", res.Revoked)
	}
	if got, _ := st.GetUsage(stale.ID); got.Status != lic.UsageStatusRevoked {
		t.Fatal("stale seat was not revoked")
	}
	if got, _ := st.GetUsage(fresh.ID); got.Status != lic.UsageStatusActive {
		t.Fatal("fresh seat must survive the sweep")
	}

	// The sweep must leave the same audit trail as an admin revoke.
	page, err := st.ListAudit(lic.AuditLogFilter{Events: []string{"usage.revoked"}}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 usage.revoked audit row, got %d", len(page.Items))
	}
}

// A non-positive window is programmer misuse and must not silently revoke
// every seat.
func TestSweepInactiveUsages_RejectsNonPositiveWindow(t *testing.T) {
	clk := &sweepClock{now: "2026-06-01T00:00:00.000000Z"}
	st := memory.New(memory.Options{Clock: clk})
	if _, err := lic.SweepInactiveUsages(st, clk, lic.SweepInactiveUsagesOptions{}); err == nil {
		t.Fatal("expected an error for a zero InactiveFor")
	}
}
