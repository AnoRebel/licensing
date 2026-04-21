package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
)

type fixedClock struct{ now string }

func (c fixedClock) NowISO() string { return c.now }

// testHarness wires up an in-memory storage + Ed25519 key hierarchy + a
// ClientHandler, returning everything callers need to exercise endpoints.
type testHarness struct {
	t       *testing.T
	storage lic.Storage
	clock   fixedClock
	reg     *lic.AlgorithmRegistry
	ctx     *ClientContext
	handler *ClientHandler
	sigPass string
}

func newHarness(t *testing.T) *testHarness {
	t.Helper()
	storage := memory.New(memory.Options{})
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}

	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed.New()); err != nil {
		t.Fatal(err)
	}

	rootPass := "root-pass-test"
	root, err := lic.GenerateRootKey(storage, clk, reg, lic.GenerateRootKeyInput{
		Alg: lic.AlgEd25519, Passphrase: rootPass,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}
	sigPass := "signing-pass-test"
	if _, err := lic.IssueInitialSigningKey(storage, clk, reg, lic.IssueInitialSigningKeyInput{
		Alg: lic.AlgEd25519, RootKid: root.Kid,
		RootPassphrase: rootPass, SigningPassphrase: sigPass,
	}, lic.KeyIssueOptions{}); err != nil {
		t.Fatalf("IssueInitialSigningKey: %v", err)
	}

	ctx := &ClientContext{
		Storage:           storage,
		Clock:             clk,
		Backends:          reg,
		SigningPassphrase: sigPass,
		Version:           "test-1.0.0",
	}
	return &testHarness{
		t: t, storage: storage, clock: clk, reg: reg,
		ctx: ctx, handler: NewClientHandler(ctx, "/api/licensing/v1"),
		sigPass: sigPass,
	}
}

// createLicense creates an active license with max_usages=3 and returns
// both the license and its generated key (which callers use when invoking
// /activate). The tag arg is only used for log readability.
func (h *testHarness) createLicense(_ string) *lic.License {
	h.t.Helper()
	key := lic.GenerateLicenseKey()
	l, err := lic.CreateLicense(h.storage, h.clock, lic.CreateLicenseInput{
		LicensableType: "User", LicensableID: "u1",
		LicenseKey: key,
		Status:     lic.LicenseStatusActive,
		MaxUsages:  3,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		h.t.Fatalf("CreateLicense: %v", err)
	}
	return l
}

// post issues a POST with JSON body and returns the envelope-decoded response.
func (h *testHarness) post(path string, body any) (*httptest.ResponseRecorder, Envelope) {
	h.t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)

	var env Envelope
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &env)
	}
	return rec, env
}

// ---------------- /health ----------------

func TestClientHandler_Health(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodGet, "/api/licensing/v1/health", nil)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status: %d, body=%s", rec.Code, rec.Body.String())
	}
	var env Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if !env.Success {
		t.Fatalf("expected success, got %+v", env)
	}
	data := env.Data.(map[string]any)
	if data["status"] != "ok" {
		t.Fatalf("status drift: %v", data["status"])
	}
	if data["version"] != "test-1.0.0" {
		t.Fatalf("version drift: %v", data["version"])
	}
}

// ---------------- /activate ----------------

func TestClientHandler_Activate_HappyPath(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-001")

	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey,
		"fingerprint": "fp-abc",
	})
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !env.Success {
		t.Fatalf("expected success, got %+v", env)
	}
	data := env.Data.(map[string]any)
	token, _ := data["token"].(string)
	if !strings.HasPrefix(token, "LIC1.") {
		t.Fatalf("token does not look like LIC1: %q", token)
	}
	if _, ok := data["expires_at"].(string); !ok {
		t.Fatal("missing expires_at")
	}
}

func TestClientHandler_Activate_UnknownKey_Returns404(t *testing.T) {
	h := newHarness(t)
	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": "does-not-exist",
		"fingerprint": "fp-abc",
	})
	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != "InvalidLicenseKey" {
		t.Fatalf("expected InvalidLicenseKey, got %+v", env.Error)
	}
}

func TestClientHandler_Activate_MissingFields_Returns400(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-001")
	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey,
	})
	if rec.Code != 400 {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if env.Error == nil || env.Error.Code != "BadRequest" {
		t.Fatalf("expected BadRequest, got %+v", env.Error)
	}
}

func TestClientHandler_Activate_SuspendedLicense_Returns403(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-SUS")
	if err := h.storage.WithTransaction(func(tx lic.StorageTx) error {
		got, err := tx.GetLicense(l.ID)
		if err != nil {
			return err
		}
		_, err = lic.Suspend(tx, got, h.clock, lic.TransitionOptions{Actor: "test"})
		return err
	}); err != nil {
		t.Fatal(err)
	}

	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey,
		"fingerprint": "fp-abc",
	})
	if rec.Code != 403 {
		t.Fatalf("expected 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if env.Error == nil || env.Error.Code != "LicenseSuspended" {
		t.Fatalf("expected LicenseSuspended, got %+v", env.Error)
	}
}

// ---------------- /refresh ----------------

func TestClientHandler_Refresh_HappyPath(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-R1")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-r",
	})
	token := env.Data.(map[string]any)["token"].(string)

	rec, env := h.post("/api/licensing/v1/refresh", map[string]any{"token": token})
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	newToken := env.Data.(map[string]any)["token"].(string)
	if newToken == "" {
		t.Fatal("refresh did not return a token")
	}
}

func TestClientHandler_Refresh_RevokedUsage_Returns403(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-R2")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-x",
	})
	token := env.Data.(map[string]any)["token"].(string)

	// Revoke the usage via deactivate.
	h.post("/api/licensing/v1/deactivate", map[string]any{
		"token": token, "reason": "user_requested",
	})

	rec, env2 := h.post("/api/licensing/v1/refresh", map[string]any{"token": token})
	if rec.Code != 403 {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	if env2.Error == nil || env2.Error.Code != "LicenseRevoked" {
		t.Fatalf("expected LicenseRevoked, got %+v", env2.Error)
	}
}

// ---------------- /heartbeat ----------------

func TestClientHandler_Heartbeat_HappyPath(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-H1")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-h",
	})
	token := env.Data.(map[string]any)["token"].(string)

	rec, env2 := h.post("/api/licensing/v1/heartbeat", map[string]any{"token": token})
	if rec.Code != 200 {
		t.Fatalf("status=%d", rec.Code)
	}
	data := env2.Data.(map[string]any)
	if data["ok"] != true {
		t.Fatalf("expected ok:true, got %+v", data)
	}
	if _, ok := data["server_time"].(string); !ok {
		t.Fatal("missing server_time")
	}
}

// ---------------- /deactivate ----------------

func TestClientHandler_Deactivate_HappyPath(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-D1")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-d",
	})
	token := env.Data.(map[string]any)["token"].(string)

	rec, _ := h.post("/api/licensing/v1/deactivate", map[string]any{
		"token": token, "reason": "user_requested",
	})
	if rec.Code != 204 {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body, got %q", rec.Body.String())
	}
}

func TestClientHandler_Deactivate_Idempotent(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-D2")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-d",
	})
	token := env.Data.(map[string]any)["token"].(string)

	// First deactivate.
	h.post("/api/licensing/v1/deactivate", map[string]any{
		"token": token, "reason": "user_requested",
	})
	// Second deactivate — must still return 204.
	rec, _ := h.post("/api/licensing/v1/deactivate", map[string]any{
		"token": token, "reason": "user_requested",
	})
	if rec.Code != 204 {
		t.Fatalf("expected 204 on idempotent deactivate, got %d", rec.Code)
	}
}

func TestClientHandler_Deactivate_InvalidReason_Returns400(t *testing.T) {
	h := newHarness(t)
	l := h.createLicense("LK-D3")

	_, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": l.LicenseKey, "fingerprint": "fp-d",
	})
	token := env.Data.(map[string]any)["token"].(string)

	rec, env2 := h.post("/api/licensing/v1/deactivate", map[string]any{
		"token": token, "reason": "not-a-valid-reason",
	})
	if rec.Code != 400 {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if env2.Error == nil || env2.Error.Code != "BadRequest" {
		t.Fatalf("expected BadRequest, got %+v", env2.Error)
	}
}

// ---------------- routing ----------------

func TestClientHandler_UnknownPath_Returns404(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodGet, "/api/licensing/v1/nope", nil)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestClientHandler_WrongMethod_Returns405(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodGet, "/api/licensing/v1/activate", nil)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestClientHandler_WrongPrefix_Returns404(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodGet, "/somewhere-else/health", nil)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}
