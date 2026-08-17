package http

import (
	"net/http"
	"net/http/httptest"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

// Admin actions must record WHICH operator performed them, not just that
// "admin" did. Before actor_kind/actor_id the identity was already on the
// request — BearerAuth attaches a Principal — and was discarded, so a
// multi-operator deployment could not answer "who revoked this licence?".
func TestAdminActor_CarriesPrincipalIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req = req.WithContext(withPrincipal(req.Context(), Principal{Subject: "ops@example.com"}))

	actor, kind, id := adminActor(req, "renew")
	if actor != "admin:renew" {
		t.Fatalf("actor label changed shape: %q", actor)
	}
	if kind != lic.ActorAdmin {
		t.Fatalf("kind: got %q want %q", kind, lic.ActorAdmin)
	}
	if id == nil || *id != "ops@example.com" {
		t.Fatalf("operator identity lost: %v", id)
	}
}

// An unauthenticated write must be visibly unattributed rather than
// labelled with a fabricated operator.
func TestAdminActor_NoPrincipalYieldsNoID(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	actor, kind, id := adminActor(req, "")
	if actor != "admin" {
		t.Fatalf("actor: %q", actor)
	}
	if kind != lic.ActorAdmin {
		t.Fatalf("kind: %q", kind)
	}
	if id != nil {
		t.Fatalf("expected no operator id, got %q", *id)
	}
}

// End-to-end: a lifecycle action through the real handler must land the
// operator on the persisted audit row.
func TestAdminLifecycle_PersistsOperatorIdentity(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "actor-1", "max_usages": 2,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	id, _ := dataAsMap(t, env)["id"].(string)

	page, err := h.storage.ListAudit(
		lic.AuditLogFilter{LicenseID: &id},
		lic.PageRequest{Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 {
		t.Fatal("no audit rows for the created license")
	}
	// Only the admin-initiated event is asserted. Harness setup also emits
	// key.signing.issued, which is genuinely a system action and must stay
	// classified as such — a blanket "everything is admin" assertion would
	// be wrong, and asserting it caught exactly that.
	var found bool
	for _, row := range page.Items {
		if row.Event != "license.created" {
			continue
		}
		found = true
		if row.ActorKind != lic.ActorAdmin {
			t.Fatalf("license.created: actor_kind = %q, want %q", row.ActorKind, lic.ActorAdmin)
		}
	}
	if !found {
		t.Fatal("no license.created audit row")
	}
}

// A row written with no explicit kind must still classify correctly, so
// call sites that were never updated keep producing usable attribution.
func TestDeriveActorKind_ClassifiesLegacyLabels(t *testing.T) {
	cases := map[string]lic.ActorKind{
		"system":       lic.ActorSystem,
		"system:sweep": lic.ActorSystem,
		"admin":        lic.ActorAdmin,
		"admin:renew":  lic.ActorAdmin,
		"client":       lic.ActorClient,
		"someone-else": lic.ActorUnknown,
		"":             lic.ActorUnknown,
	}
	for label, want := range cases {
		if got := lic.DeriveActorKind(label); got != want {
			t.Errorf("DeriveActorKind(%q) = %q, want %q", label, got, want)
		}
	}
}
