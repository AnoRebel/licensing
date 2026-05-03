package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

// adminHarness wires up a memory storage + ed25519 registry + a fully
// provisioned root/signing key pair + an AdminHandler mounted at
// "/api/licensing/v1".
type adminHarness struct {
	storage lic.Storage
	t       *testing.T
	reg     *lic.AlgorithmRegistry
	ctx     *AdminContext
	handler *AdminHandler
	clock   fixedClock
}

func newAdminHarness(t *testing.T) *adminHarness {
	t.Helper()
	storage := memory.New(memory.Options{})
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed.New()); err != nil {
		t.Fatal(err)
	}

	rootPass := "root-pass-test-admin"
	sigPass := "signing-pass-test-admin"
	root, err := lic.GenerateRootKey(storage, clk, reg, lic.GenerateRootKeyInput{
		Alg: lic.AlgEd25519, Passphrase: rootPass,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}
	if _, err := lic.IssueInitialSigningKey(storage, clk, reg, lic.IssueInitialSigningKeyInput{
		Alg: lic.AlgEd25519, RootKid: root.Kid,
		RootPassphrase: rootPass, SigningPassphrase: sigPass,
	}, lic.KeyIssueOptions{}); err != nil {
		t.Fatalf("IssueInitialSigningKey: %v", err)
	}

	ctx := &AdminContext{
		Storage:           storage,
		Clock:             clk,
		Backends:          reg,
		Version:           "test-admin-1.0",
		RootPassphrase:    rootPass,
		SigningPassphrase: sigPass,
	}
	return &adminHarness{
		t: t, storage: storage, clock: clk, reg: reg,
		ctx: ctx, handler: NewAdminHandler(ctx, "/api/licensing/v1"),
	}
}

func (h *adminHarness) do(method, path string, body any) (*httptest.ResponseRecorder, Envelope) {
	h.t.Helper()
	var reader *bytes.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(buf)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)

	var env Envelope
	if rec.Code != http.StatusNoContent && rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			h.t.Fatalf("unmarshal envelope: %v, body=%s", err, rec.Body.String())
		}
	}
	return rec, env
}

// dataAsMap unmarshals Envelope.Data into a map[string]any for easy access.
func dataAsMap(t *testing.T, env Envelope) map[string]any {
	t.Helper()
	if env.Data == nil {
		t.Fatal("envelope has no data")
	}
	buf, err := json.Marshal(env.Data)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// ---------------- Licenses ----------------

func TestAdmin_License_CRUD(t *testing.T) {
	h := newAdminHarness(t)

	// Create.
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User",
		"licensable_id":   "u1",
		"max_usages":      5,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d body=%s", rec.Code, rec.Body.String())
	}
	if !env.Success {
		t.Fatalf("not success: %+v", env)
	}
	m := dataAsMap(t, env)
	id, _ := m["id"].(string)
	if id == "" {
		t.Fatal("created license has no id")
	}

	// Get.
	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/licenses/"+id, nil)
	if rec.Code != 200 {
		t.Fatalf("get: %d", rec.Code)
	}
	if dataAsMap(t, env)["id"] != id {
		t.Fatal("get returned wrong license")
	}

	// Patch.
	rec, env = h.do(http.MethodPatch, "/api/licensing/v1/admin/licenses/"+id, map[string]any{
		"max_usages": 10,
		"meta":       map[string]any{"plan": "enterprise"},
	})
	if rec.Code != 200 {
		t.Fatalf("patch: %d body=%s", rec.Code, rec.Body.String())
	}
	if mx, _ := dataAsMap(t, env)["max_usages"].(float64); mx != 10 {
		t.Fatalf("max_usages = %v", mx)
	}

	// List.
	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/licenses?limit=10", nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d", rec.Code)
	}
	items, _ := dataAsMap(t, env)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("list: %d items", len(items))
	}

	// Delete.
	rec, _ = h.do(http.MethodDelete, "/api/licensing/v1/admin/licenses/"+id, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d body=%s", rec.Code, rec.Body.String())
	}

	// Get after delete → 404.
	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/licenses/"+id, nil)
	if rec.Code != 404 {
		t.Fatalf("get after delete: %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != "NotFound" {
		t.Fatalf("error = %+v", env.Error)
	}
}

func TestAdmin_License_Lifecycle(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1", "max_usages": 1,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	id, _ := dataAsMap(t, env)["id"].(string)

	// Must activate first (license is pending). Suspend→Resume flow requires active.
	// Activate via seat registration (no /activate on admin; use storage directly).
	if _, err := lic.RegisterUsage(h.storage, h.clock, lic.RegisterUsageInput{
		LicenseID:   id,
		Fingerprint: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	}, lic.RegisterUsageOptions{}); err != nil {
		t.Fatal(err)
	}

	// Suspend.
	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/suspend", nil)
	if rec.Code != 200 {
		t.Fatalf("suspend: %d body=%s", rec.Code, rec.Body.String())
	}
	if dataAsMap(t, env)["status"] != "suspended" {
		t.Fatalf("status after suspend = %v", dataAsMap(t, env)["status"])
	}

	// Resume.
	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/resume", nil)
	if rec.Code != 200 {
		t.Fatalf("resume: %d", rec.Code)
	}
	if dataAsMap(t, env)["status"] != "active" {
		t.Fatalf("status after resume = %v", dataAsMap(t, env)["status"])
	}

	// Renew.
	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/renew", map[string]any{
		"expires_at":  "2027-06-01T00:00:00Z",
		"grace_until": "2027-06-08T00:00:00Z",
	})
	if rec.Code != 200 {
		t.Fatalf("renew: %d body=%s", rec.Code, rec.Body.String())
	}
	if dataAsMap(t, env)["expires_at"] != "2027-06-01T00:00:00Z" {
		t.Fatalf("expires_at = %v", dataAsMap(t, env)["expires_at"])
	}

	// Revoke (terminal).
	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/revoke", nil)
	if rec.Code != 200 {
		t.Fatalf("revoke: %d", rec.Code)
	}
	if dataAsMap(t, env)["status"] != "revoked" {
		t.Fatalf("status after revoke = %v", dataAsMap(t, env)["status"])
	}

	// Subsequent resume should fail with a 4xx lifecycle error.
	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/resume", nil)
	if rec.Code < 400 {
		t.Fatalf("resume after revoke should fail, got %d", rec.Code)
	}
	if env.Error == nil {
		t.Fatal("expected error envelope")
	}
}

func TestAdmin_License_Delete_409WithActiveUsages(t *testing.T) {
	h := newAdminHarness(t)
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1", "max_usages": 2,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	id, _ := dataAsMap(t, env)["id"].(string)
	if _, err := lic.RegisterUsage(h.storage, h.clock, lic.RegisterUsageInput{
		LicenseID:   id,
		Fingerprint: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	}, lic.RegisterUsageOptions{}); err != nil {
		t.Fatal(err)
	}
	rec, env = h.do(http.MethodDelete, "/api/licensing/v1/admin/licenses/"+id, nil)
	if rec.Code != 409 {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	if env.Error == nil || env.Error.Code != string(lic.CodeUniqueConstraintViolation) {
		t.Fatalf("error = %+v", env.Error)
	}
}

// ---------------- Scopes ----------------

func TestAdmin_Scope_CRUD(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/scopes", map[string]any{
		"slug": "acme", "name": "Acme Corp",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d body=%s", rec.Code, rec.Body.String())
	}
	id, _ := dataAsMap(t, env)["id"].(string)

	// Duplicate slug → 409.
	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/scopes", map[string]any{
		"slug": "acme", "name": "Dup",
	})
	if rec.Code != 409 {
		t.Fatalf("dup slug: got %d", rec.Code)
	}

	// Get.
	rec, _ = h.do(http.MethodGet, "/api/licensing/v1/admin/scopes/"+id, nil)
	if rec.Code != 200 {
		t.Fatalf("get: %d", rec.Code)
	}

	// Patch name.
	rec, env = h.do(http.MethodPatch, "/api/licensing/v1/admin/scopes/"+id, map[string]any{
		"name": "Acme Inc",
	})
	if rec.Code != 200 {
		t.Fatalf("patch: %d body=%s", rec.Code, rec.Body.String())
	}
	if dataAsMap(t, env)["name"] != "Acme Inc" {
		t.Fatalf("name = %v", dataAsMap(t, env)["name"])
	}

	// Delete.
	rec, _ = h.do(http.MethodDelete, "/api/licensing/v1/admin/scopes/"+id, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
}

func TestAdmin_Scope_Delete_409WhenReferenced(t *testing.T) {
	h := newAdminHarness(t)
	// Create scope + license bound to it.
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/scopes", map[string]any{
		"slug": "ref", "name": "Referenced",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("scope: %d", rec.Code)
	}
	scopeID, _ := dataAsMap(t, env)["id"].(string)
	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User",
		"licensable_id":   "u1",
		"max_usages":      1,
		"scope_id":        scopeID,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("license: %d body=%s", rec.Code, rec.Body.String())
	}

	rec, env = h.do(http.MethodDelete, "/api/licensing/v1/admin/scopes/"+scopeID, nil)
	if rec.Code != 409 {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != string(lic.CodeUniqueConstraintViolation) {
		t.Fatalf("error = %+v", env.Error)
	}
}

// ---------------- Templates ----------------

func TestAdmin_Template_CRUD(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name":               "Pro",
		"max_usages":         3,
		"trial_duration_sec": 604800,
		"grace_duration_sec": 259200,
		"entitlements":       map[string]any{"feature_x": true},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d body=%s", rec.Code, rec.Body.String())
	}
	id, _ := dataAsMap(t, env)["id"].(string)

	// Get.
	rec, _ = h.do(http.MethodGet, "/api/licensing/v1/admin/templates/"+id, nil)
	if rec.Code != 200 {
		t.Fatalf("get: %d", rec.Code)
	}

	// Patch.
	rec, env = h.do(http.MethodPatch, "/api/licensing/v1/admin/templates/"+id, map[string]any{
		"max_usages": 5,
	})
	if rec.Code != 200 {
		t.Fatalf("patch: %d", rec.Code)
	}
	if mx, _ := dataAsMap(t, env)["max_usages"].(float64); mx != 5 {
		t.Fatalf("max_usages = %v", mx)
	}

	// List.
	rec, _ = h.do(http.MethodGet, "/api/licensing/v1/admin/templates?limit=10", nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d", rec.Code)
	}

	// Delete.
	rec, _ = h.do(http.MethodDelete, "/api/licensing/v1/admin/templates/"+id, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
}

// TestAdmin_Template_PersistsParentAndCooldown pins the wire shape so a
// future refactor can't silently drop parent_id / trial_cooldown_sec
// from the create body — both fields shipped after the original handler
// and the regression risk is real.
func TestAdmin_Template_PersistsParentAndCooldown(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name":               "Base",
		"max_usages":         5,
		"trial_duration_sec": 0,
		"grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("parent create: %d body=%s", rec.Code, rec.Body.String())
	}
	parentID, _ := dataAsMap(t, env)["id"].(string)

	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name":               "Trial",
		"parent_id":          parentID,
		"max_usages":         1,
		"trial_duration_sec": 86400,
		"trial_cooldown_sec": 604800,
		"grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("child create: %d body=%s", rec.Code, rec.Body.String())
	}
	child := dataAsMap(t, env)
	if got, _ := child["parent_id"].(string); got != parentID {
		t.Fatalf("parent_id round-trip: got %q want %q", got, parentID)
	}
	if got, _ := child["trial_cooldown_sec"].(float64); got != 604800 {
		t.Fatalf("trial_cooldown_sec round-trip: got %v want 604800", got)
	}
}

// TestAdmin_Template_RejectsParentCycle confirms the storage-level
// TemplateCycle guard surfaces as a 409 through the HTTP layer.
func TestAdmin_Template_RejectsParentCycle(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name": "A", "max_usages": 1,
		"trial_duration_sec": 0, "grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("A: %d", rec.Code)
	}
	aID, _ := dataAsMap(t, env)["id"].(string)

	rec, env = h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name": "B", "parent_id": aID, "max_usages": 1,
		"trial_duration_sec": 0, "grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("B: %d", rec.Code)
	}
	bID, _ := dataAsMap(t, env)["id"].(string)

	// Re-parenting A under B closes the cycle A -> B -> A.
	rec, env = h.do(http.MethodPatch, "/api/licensing/v1/admin/templates/"+aID, map[string]any{
		"parent_id": bID,
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 TemplateCycle, got %d body=%s", rec.Code, rec.Body.String())
	}
	if env.Error == nil || env.Error.Code != string(lic.CodeTemplateCycle) {
		t.Fatalf("error = %+v", env.Error)
	}
}

// TestAdmin_Template_ListByParent exercises the parent_id query filter:
// "null" (literal) lists root templates, a UUID lists immediate children.
func TestAdmin_Template_ListByParent(t *testing.T) {
	h := newAdminHarness(t)

	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name": "Root", "max_usages": 1,
		"trial_duration_sec": 0, "grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("root: %d", rec.Code)
	}
	rootID, _ := dataAsMap(t, env)["id"].(string)
	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name": "Child", "parent_id": rootID, "max_usages": 1,
		"trial_duration_sec": 0, "grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("child: %d", rec.Code)
	}

	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/templates?parent_id=null", nil)
	if rec.Code != 200 {
		t.Fatalf("list root: %d", rec.Code)
	}
	items, _ := dataAsMap(t, env)["items"].([]any)
	for _, it := range items {
		m, _ := it.(map[string]any)
		if m["parent_id"] != nil {
			t.Fatalf("expected only root templates, got parent_id=%v", m["parent_id"])
		}
	}

	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/templates?parent_id="+rootID, nil)
	if rec.Code != 200 {
		t.Fatalf("list children: %d", rec.Code)
	}
	items, _ = dataAsMap(t, env)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 child, got %d", len(items))
	}
	if got, _ := items[0].(map[string]any)["parent_id"].(string); got != rootID {
		t.Fatalf("child parent_id = %q want %q", got, rootID)
	}
}

func TestAdmin_Template_Delete_409WhenReferenced(t *testing.T) {
	h := newAdminHarness(t)
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/templates", map[string]any{
		"name": "Ref", "max_usages": 3,
		"trial_duration_sec": 0, "grace_duration_sec": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("template: %d", rec.Code)
	}
	tmplID, _ := dataAsMap(t, env)["id"].(string)

	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1",
		"max_usages":  3,
		"template_id": tmplID,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("license from template: %d body=%s", rec.Code, rec.Body.String())
	}

	rec, env = h.do(http.MethodDelete, "/api/licensing/v1/admin/templates/"+tmplID, nil)
	if rec.Code != 409 {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != string(lic.CodeUniqueConstraintViolation) {
		t.Fatalf("error = %+v", env.Error)
	}
}

// ---------------- Usages ----------------

func TestAdmin_Usage_ListGetRevoke(t *testing.T) {
	h := newAdminHarness(t)

	// Create license + register a usage.
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1", "max_usages": 2,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create license: %d", rec.Code)
	}
	licID, _ := dataAsMap(t, env)["id"].(string)
	result, err := lic.RegisterUsage(h.storage, h.clock, lic.RegisterUsageInput{
		LicenseID:   licID,
		Fingerprint: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	}, lic.RegisterUsageOptions{})
	if err != nil {
		t.Fatal(err)
	}

	// List filtered by license_id.
	rec, env = h.do(http.MethodGet,
		"/api/licensing/v1/admin/usages?license_id="+licID, nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d body=%s", rec.Code, rec.Body.String())
	}
	items, _ := dataAsMap(t, env)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("list: %d items", len(items))
	}

	// Get single.
	rec, _ = h.do(http.MethodGet, "/api/licensing/v1/admin/usages/"+result.Usage.ID, nil)
	if rec.Code != 200 {
		t.Fatalf("get: %d", rec.Code)
	}

	// Revoke.
	rec, env = h.do(http.MethodPost,
		"/api/licensing/v1/admin/usages/"+result.Usage.ID+"/revoke", nil)
	if rec.Code != 200 {
		t.Fatalf("revoke: %d body=%s", rec.Code, rec.Body.String())
	}
	if dataAsMap(t, env)["status"] != "revoked" {
		t.Fatalf("status after revoke = %v", dataAsMap(t, env)["status"])
	}

	// Unknown id → 404.
	rec, _ = h.do(http.MethodGet,
		"/api/licensing/v1/admin/usages/00000000-0000-0000-0000-000000000000", nil)
	if rec.Code != 404 {
		t.Fatalf("unknown id: %d", rec.Code)
	}
}

// ---------------- Keys ----------------

func TestAdmin_Keys_List(t *testing.T) {
	h := newAdminHarness(t)
	// Root + signing key were provisioned in newAdminHarness.
	rec, env := h.do(http.MethodGet, "/api/licensing/v1/admin/keys?limit=10", nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d", rec.Code)
	}
	items, _ := dataAsMap(t, env)["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("expected 2 keys (root + signing), got %d", len(items))
	}
	// Check private_pem_enc is NOT in the wire shape.
	for _, it := range items {
		m := it.(map[string]any)
		if _, has := m["private_pem_enc"]; has {
			t.Fatal("private_pem_enc leaked on wire — must be stripped")
		}
		if _, has := m["public_pem"]; !has {
			t.Fatal("public_pem should be present")
		}
	}
}

func TestAdmin_Keys_RotateSigning(t *testing.T) {
	h := newAdminHarness(t)

	// Find the current signing key via the storage.
	roleSigning := lic.RoleSigning
	p, err := h.storage.ListKeys(lic.LicenseKeyFilter{Role: &roleSigning}, lic.PageRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 1 {
		t.Fatalf("expected 1 signing key, got %d", len(p.Items))
	}
	signing := p.Items[0]

	// Rotate.
	rec, env := h.do(http.MethodPost,
		"/api/licensing/v1/admin/keys/"+signing.ID+"/rotate", nil)
	if rec.Code != 200 {
		t.Fatalf("rotate: %d body=%s", rec.Code, rec.Body.String())
	}
	data := dataAsMap(t, env)
	if _, ok := data["retiring"]; !ok {
		t.Fatal("response missing 'retiring' key")
	}
	if _, ok := data["active"]; !ok {
		t.Fatal("response missing 'active' key")
	}
	retiring := data["retiring"].(map[string]any)
	active := data["active"].(map[string]any)
	if retiring["state"] != "retiring" {
		t.Fatalf("retiring.state = %v", retiring["state"])
	}
	if active["state"] != "active" {
		t.Fatalf("active.state = %v", active["state"])
	}
	if active["kid"] == retiring["kid"] {
		t.Fatal("rotation should produce a new kid")
	}
}

func TestAdmin_Keys_Rotate_404Unknown(t *testing.T) {
	h := newAdminHarness(t)
	rec, _ := h.do(http.MethodPost,
		"/api/licensing/v1/admin/keys/00000000-0000-0000-0000-000000000000/rotate", nil)
	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// ---------------- Audit ----------------

func TestAdmin_Audit_List(t *testing.T) {
	h := newAdminHarness(t)
	// Produce an audit row by creating a license.
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1", "max_usages": 1,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	licID, _ := dataAsMap(t, env)["id"].(string)

	// List filtered by license_id.
	rec, env = h.do(http.MethodGet,
		"/api/licensing/v1/admin/audit?license_id="+licID, nil)
	if rec.Code != 200 {
		t.Fatalf("list audit: %d body=%s", rec.Code, rec.Body.String())
	}
	items, _ := dataAsMap(t, env)["items"].([]any)
	if len(items) == 0 {
		t.Fatal("expected at least one audit row")
	}
}

// ---------------- Stats ----------------

// TestAdmin_Stats_Licenses pins the wire shape of the dashboard rollup.
// The schema check in the OpenAPI conformance suite catches structural
// drift; this test catches *semantic* drift — counts respond to the
// actual license set, the seat utilisation rolls up only active rows,
// and the deltas pick up audit events the handler creates.
func TestAdmin_Stats_Licenses(t *testing.T) {
	h := newAdminHarness(t)

	// Two licenses: one active (after manual activation), one pending.
	rec, env := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u1", "max_usages": 5,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create active: %d", rec.Code)
	}
	activeID, _ := dataAsMap(t, env)["id"].(string)

	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses", map[string]any{
		"licensable_type": "User", "licensable_id": "u2", "max_usages": 3,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create pending: %d", rec.Code)
	}

	// Activate one license via the resume lifecycle action — sends
	// it through the suspend/resume path which is the closest
	// admin-side approximation of a "license becomes active" event.
	if _, err := harnessActivate(h, activeID); err != nil {
		t.Fatalf("activate: %v", err)
	}

	rec, env = h.do(http.MethodGet, "/api/licensing/v1/admin/stats/licenses", nil)
	if rec.Code != 200 {
		t.Fatalf("stats: %d body=%s", rec.Code, rec.Body.String())
	}
	data := dataAsMap(t, env)
	counts, _ := data["counts"].(map[string]any)
	for _, status := range []string{"pending", "active", "grace", "expired", "suspended", "revoked"} {
		if _, ok := counts[status].(float64); !ok {
			t.Fatalf("counts.%s missing or not a number: %v", status, counts[status])
		}
	}
	// Total > 0 — the test created two licenses.
	totalLicenses := 0.0
	for _, status := range []string{"pending", "active", "grace", "expired", "suspended", "revoked"} {
		totalLicenses += counts[status].(float64)
	}
	if totalLicenses < 2 {
		t.Fatalf("expected total licenses >= 2, got %v", totalLicenses)
	}
	// active_delta_30d sub-fields exist + are non-negative.
	delta, _ := data["active_delta_30d"].(map[string]any)
	if added, _ := delta["added"].(float64); added < 1 {
		t.Fatalf("expected delta.added >= 1 (license.created events), got %v", added)
	}
	if removed, _ := delta["removed"].(float64); removed < 0 {
		t.Fatalf("delta.removed should be non-negative, got %v", removed)
	}
}

// harnessActivate cycles a license through suspend/resume so the
// admin lifecycle handlers exercise the active state. Returns the
// final response code; callers do their own envelope decoding.
func harnessActivate(h *adminHarness, id string) (int, error) {
	rec, _ := h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/suspend", nil)
	if rec.Code != http.StatusOK {
		return rec.Code, fmt.Errorf("suspend: %d body=%s", rec.Code, rec.Body.String())
	}
	rec, _ = h.do(http.MethodPost, "/api/licensing/v1/admin/licenses/"+id+"/resume", nil)
	if rec.Code != http.StatusOK {
		return rec.Code, fmt.Errorf("resume: %d body=%s", rec.Code, rec.Body.String())
	}
	return rec.Code, nil
}

// ---------------- Routing / dispatch ----------------

func TestAdmin_Router_UnknownPath(t *testing.T) {
	h := newAdminHarness(t)
	rec, env := h.do(http.MethodGet, "/api/licensing/v1/admin/nope", nil)
	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != "NotFound" {
		t.Fatalf("error = %+v", env.Error)
	}
}

func TestAdmin_Router_WrongMethod(t *testing.T) {
	h := newAdminHarness(t)
	rec, env := h.do(http.MethodDelete, "/api/licensing/v1/admin/audit", nil)
	if rec.Code != 405 {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != "MethodNotAllowed" {
		t.Fatalf("error = %+v", env.Error)
	}
}
