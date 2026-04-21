package client

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// refreshServer returns a test server that responds with the given
// token in a success envelope for any POST to the refresh path.
func refreshServer(t *testing.T, newToken string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/licensing/v1/refresh", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data":    map[string]any{"token": newToken},
		})
	})
	return httptest.NewServer(mux)
}

func TestRefresh_NotDue(t *testing.T) {
	now := int64(1700000000)
	tok := issueTestToken(t, basePayload(now))

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok})

	// No server needed — proactive threshold not hit, no force_online_after.
	out, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: "http://unused.invalid"},
		Store:     store,
		NowSec:    now,
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if out.Kind != RefreshKindNotDue {
		t.Fatalf("expected NotDue, got %s", out.Kind)
	}
}

func TestRefresh_ProactiveSuccess(t *testing.T) {
	now := int64(1700000000)
	// Token with ~10% life remaining — below default 0.25 threshold.
	p := basePayload(now)
	p["iat"] = now - 900
	p["nbf"] = now - 900
	p["exp"] = now + 100

	oldTok := issueTestToken(t, p)

	// Build a new token with fresh lifetime for the server to return.
	p2 := basePayload(now)
	p2["jti"] = "jti-2"
	newTok := issueTestToken(t, p2)

	srv := refreshServer(t, newTok)
	defer srv.Close()

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: oldTok})

	out, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: srv.URL},
		Store:     store,
		NowSec:    now,
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if out.Kind != RefreshKindRefreshed {
		t.Fatalf("expected Refreshed, got %s", out.Kind)
	}
	if out.Token != newTok {
		t.Fatal("new token not returned")
	}

	// Store should hold new token.
	state, _ := store.Read()
	if state.Token != newTok {
		t.Fatal("store not updated with new token")
	}
}

func TestRefresh_ForcedGraceEntered(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	// force_online_after has passed.
	foa := now - 1
	p["force_online_after"] = foa
	tok := issueTestToken(t, p)

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok})

	// Server that returns 503 → IssuerUnreachable.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	out, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: srv.URL},
		Store:     store,
		NowSec:    now,
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if out.Kind != RefreshKindGraceEntered {
		t.Fatalf("expected GraceEntered, got %s", out.Kind)
	}
	if out.GraceStartSec == nil || *out.GraceStartSec != now {
		t.Fatalf("grace start drift: %v", out.GraceStartSec)
	}

	// Store should have grace timestamp.
	state, _ := store.Read()
	if state.GraceStartSec == nil {
		t.Fatal("store should have grace start")
	}
}

func TestRefresh_ForcedGraceContinued(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	foa := now - 1
	p["force_online_after"] = foa
	tok := issueTestToken(t, p)

	graceStart := now - 100
	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok, GraceStartSec: &graceStart})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	out, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: srv.URL},
		Store:     store,
		NowSec:    now,
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if out.Kind != RefreshKindGraceContinued {
		t.Fatalf("expected GraceContinued, got %s", out.Kind)
	}
	if out.GraceStartSec == nil || *out.GraceStartSec != graceStart {
		t.Fatalf("grace start should be preserved: %v", out.GraceStartSec)
	}
}

func TestRefresh_GraceExpired(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	foa := now - 1
	p["force_online_after"] = foa
	tok := issueTestToken(t, p)

	// Grace started 8 days ago (> default 7-day window).
	graceStart := now - 8*86400
	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok, GraceStartSec: &graceStart})

	_, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: "http://unused.invalid"},
		Store:     store,
		NowSec:    now,
	})
	if !errors.Is(err, ErrGraceExpired) {
		t.Fatalf("expected ErrGraceExpired, got %v", err)
	}
}

func TestRefresh_ForcedNoGraceWindow_RequiresOnline(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	foa := now - 1
	p["force_online_after"] = foa
	tok := issueTestToken(t, p)

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	_, err := Refresh(RefreshOptions{
		Transport:      TransportOptions{BaseURL: srv.URL},
		Store:          store,
		NowSec:         now,
		GraceWindowSec: 0,
		GraceWindowSet: true,
	})
	if !errors.Is(err, ErrRequiresOnlineRefresh) {
		t.Fatalf("expected ErrRequiresOnlineRefresh, got %v", err)
	}
}

func TestRefresh_ProactiveUnreachableSwallowed(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	p["iat"] = now - 900
	p["nbf"] = now - 900
	p["exp"] = now + 100
	tok := issueTestToken(t, p)

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	out, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: srv.URL},
		Store:     store,
		NowSec:    now,
	})
	if err != nil {
		t.Fatalf("proactive unreachable should swallow, got: %v", err)
	}
	if out.Kind != RefreshKindNotDue {
		t.Fatalf("expected NotDue, got %s", out.Kind)
	}
}

func TestRefresh_ForcedProtocolErrorDoesNotEnterGrace(t *testing.T) {
	now := int64(1700000000)
	p := basePayload(now)
	foa := now - 1
	p["force_online_after"] = foa
	tok := issueTestToken(t, p)

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: tok})

	// Issuer returns a structured error with an UNKNOWN code. Must map to
	// IssuerProtocolError and refresh must propagate — not enter grace.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"error": map[string]any{
				"code":    "MaliciousNewCode",
				"message": "attempt to force grace",
			},
		})
	}))
	defer srv.Close()

	_, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: srv.URL},
		Store:     store,
		NowSec:    now,
	})
	if !errors.Is(err, ErrIssuerProtocolError) {
		t.Fatalf("expected ErrIssuerProtocolError, got %v", err)
	}

	// Store must NOT have been mutated into grace.
	state, _ := store.Read()
	if state.GraceStartSec != nil {
		t.Fatal("protocol error must not induce grace entry")
	}
}

func TestRefresh_NoTokenInStore(t *testing.T) {
	store := NewMemoryTokenStore()

	_, err := Refresh(RefreshOptions{
		Transport: TransportOptions{BaseURL: "http://unused.invalid"},
		Store:     store,
		NowSec:    1700000000,
	})
	if !errors.Is(err, ErrNoToken) {
		t.Fatalf("expected ErrNoToken, got %v", err)
	}
}
