package licensing_test

import (
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

type rotClock struct{ now string }

func (c rotClock) NowISO() string { return c.now }

func newRotFixture(t *testing.T) (*memory.Storage, rotClock, *lic.License) {
	t.Helper()
	clk := rotClock{now: "2026-06-01T00:00:00.000000Z"}
	st := memory.New(memory.Options{Clock: clk})
	l, err := lic.CreateLicense(st, clk, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "rot-1",
		LicenseKey: lic.GenerateLicenseKey(),
		Status:     lic.LicenseStatusActive, MaxUsages: 5,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return st, clk, l
}

// Rotation must change the key AND clear every seat — a rotation that left
// devices running would not contain a leaked key, which is its only purpose.
func TestRotateLicenseKey_ReplacesKeyAndRevokesSeats(t *testing.T) {
	st, clk, l := newRotFixture(t)
	oldKey := l.LicenseKey

	for _, fp := range []string{"a", "b"} {
		if _, err := lic.RegisterUsage(st, clk, lic.RegisterUsageInput{
			LicenseID: l.ID, Fingerprint: fp + "1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
		}, lic.RegisterUsageOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	res, err := lic.RotateLicenseKey(st, clk, l.ID, lic.RotateLicenseKeyOptions{
		Actor: "admin:rotate-key", ActorKind: lic.ActorAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}

	if res.License.LicenseKey == oldKey {
		t.Fatal("license_key did not change")
	}
	if len(res.RevokedUsageIDs) != 2 {
		t.Fatalf("expected 2 seats revoked, got %d", len(res.RevokedUsageIDs))
	}

	// The old key must no longer resolve; the new one must.
	if got, _ := st.GetLicenseByKey(oldKey); got != nil {
		t.Fatal("the old license_key still resolves")
	}
	if got, _ := st.GetLicenseByKey(res.License.LicenseKey); got == nil {
		t.Fatal("the new license_key does not resolve")
	}

	// Every seat is gone, so each device must re-activate.
	page, err := st.ListUsages(lic.LicenseUsageFilter{
		LicenseID: &l.ID, Status: []lic.UsageStatus{lic.UsageStatusActive},
	}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("expected no active seats after rotation, got %d", len(page.Items))
	}
}

// The audit row records that a rotation happened without recording either
// key — an append-only log that support staff can read must not carry the
// secret the rotation exists to protect.
func TestRotateLicenseKey_AuditOmitsKeyMaterial(t *testing.T) {
	st, clk, l := newRotFixture(t)
	oldKey := l.LicenseKey

	res, err := lic.RotateLicenseKey(st, clk, l.ID, lic.RotateLicenseKeyOptions{
		Actor: "admin:rotate-key", ActorKind: lic.ActorAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}

	page, err := st.ListAudit(lic.AuditLogFilter{
		Events: []string{"license.key_rotated"},
	}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 license.key_rotated row, got %d", len(page.Items))
	}
	row := page.Items[0]
	if row.ActorKind != lic.ActorAdmin {
		t.Fatalf("actor_kind = %q, want admin", row.ActorKind)
	}
	for _, state := range []map[string]any{row.PriorState, row.NewState} {
		for k, v := range state {
			if s, ok := v.(string); ok && (s == oldKey || s == res.License.LicenseKey) {
				t.Fatalf("audit field %q leaked a license key", k)
			}
		}
	}
}

// Revoked is terminal; handing out a new key would imply the license could
// still be used.
func TestRotateLicenseKey_RefusesRevokedLicense(t *testing.T) {
	st, clk, l := newRotFixture(t)
	if err := st.WithTransaction(func(tx lic.StorageTx) error {
		cur, err := tx.GetLicense(l.ID)
		if err != nil {
			return err
		}
		_, err = lic.Revoke(tx, cur, clk, lic.TransitionOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := lic.RotateLicenseKey(st, clk, l.ID, lic.RotateLicenseKeyOptions{}); err == nil {
		t.Fatal("expected rotation of a revoked license to fail")
	}
}
