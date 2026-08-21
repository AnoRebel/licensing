package http

import (
	"encoding/json"
	"strings"
	"testing"

	lic "github.com/AnoRebel/licensing/licensing"
)

// A server configured to issue LIC2 must accept the tokens it issued.
//
// Regression test for a real defect: verifyClientToken used
// lic.DecodeUnverified and lic.Verify, both LIC1-only by contract. A
// LIC2-configured deployment would mint a token on /activate and then
// reject that same token on /refresh, /heartbeat, and /deactivate — the
// device would activate successfully and then be unable to do anything
// else, permanently.
//
// The whole HTTP suite stayed green because every other test runs with the
// default (LIC1) format.
func TestLIC2Server_IssuedTokenIsAcceptedBack(t *testing.T) {
	h := newHarness(t)
	h.ctx.TokenFormat = lic.FormatLIC2

	license := h.createLicense("lic2-roundtrip")

	// 1. Activate — the server mints a LIC2 token.
	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": license.LicenseKey,
		"fingerprint": strings.Repeat("a", 64),
	})
	if rec.Code != 200 {
		t.Fatalf("activate: got %d, body %+v", rec.Code, env)
	}
	token := tokenFromEnvelope(t, env)
	if !strings.HasPrefix(token, lic.LIC2Prefix) {
		t.Fatalf("expected a LIC2 token, got %.20s...", token)
	}

	// 2. Heartbeat — the server must accept the token it just issued.
	rec, env = h.post("/api/licensing/v1/heartbeat", map[string]any{"token": token})
	if rec.Code != 200 {
		t.Fatalf("heartbeat rejected the server's own LIC2 token: %d %+v", rec.Code, env)
	}

	// 3. Refresh — same requirement, and the replacement must also be LIC2.
	rec, env = h.post("/api/licensing/v1/refresh", map[string]any{"token": token})
	if rec.Code != 200 {
		t.Fatalf("refresh rejected the server's own LIC2 token: %d %+v", rec.Code, env)
	}
	refreshed := tokenFromEnvelope(t, env)
	if !strings.HasPrefix(refreshed, lic.LIC2Prefix) {
		t.Fatalf("refresh returned a non-LIC2 token: %.20s...", refreshed)
	}

	// 4. Deactivate — closes the loop.
	rec, env = h.post("/api/licensing/v1/deactivate", map[string]any{"token": refreshed, "reason": "user_requested"})
	if rec.Code != 200 && rec.Code != 204 {
		t.Fatalf("deactivate rejected a LIC2 token: %d %+v", rec.Code, env)
	}
}

// The default is unchanged: a server with no TokenFormat set issues LIC1.
func TestLIC2Server_DefaultsToLIC1(t *testing.T) {
	h := newHarness(t)
	license := h.createLicense("default-format")

	rec, env := h.post("/api/licensing/v1/activate", map[string]any{
		"license_key": license.LicenseKey,
		"fingerprint": strings.Repeat("b", 64),
	})
	if rec.Code != 200 {
		t.Fatalf("activate: got %d, body %+v", rec.Code, env)
	}
	token := tokenFromEnvelope(t, env)
	if !strings.HasPrefix(token, lic.LIC1Prefix) {
		t.Fatalf("an unconfigured server must issue LIC1, got %.20s...", token)
	}
}

func tokenFromEnvelope(t *testing.T, env Envelope) string {
	t.Helper()
	raw, err := json.Marshal(env.Data)
	if err != nil {
		t.Fatalf("marshal envelope data: %v", err)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode envelope data: %v", err)
	}
	if payload.Token == "" {
		t.Fatalf("no token in response: %s", raw)
	}
	return payload.Token
}
