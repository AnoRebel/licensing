package client

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Tests for SendOneHeartbeat. Coverage focuses on:
//
//  1. The request body shape matches the server contract (token, not
//     license_key + fingerprint + …) — earlier client versions sent the
//     wrong fields and the server returned 400 BadRequest for every
//     heartbeat. The first test locks the contract down.
//  2. Revocation auto-clear: a server response of LicenseRevoked /
//     LicenseSuspended causes the client to clear its local store so the
//     next guard / activate cycle prompts re-authentication.
//  3. Concurrency safety: a parallel Refresh that wrote a fresh token
//     between our Read and the typed-error reaction must NOT be
//     clobbered (CAS-style guard).

func TestSendOneHeartbeat_SendsTokenInRequestBody(t *testing.T) {
	var captured heartbeatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data":    map[string]any{"ok": true},
		})
	}))
	defer srv.Close()

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: "LIC1.fake.token.value"})
	ok := SendOneHeartbeat(HeartbeatOptions{
		Store:     store,
		Path:      "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	})
	if !ok {
		t.Fatal("heartbeat should have succeeded")
	}
	if captured.Token != "LIC1.fake.token.value" {
		t.Fatalf("server received wrong token: %q", captured.Token)
	}
}

func TestSendOneHeartbeat_NoStoreIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer srv.Close()
	ok := SendOneHeartbeat(HeartbeatOptions{
		Path:      "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	})
	if !ok {
		t.Fatal("heartbeat with nil store should report ok")
	}
	if called {
		t.Fatal("heartbeat with nil store must not hit the network")
	}
}

func TestSendOneHeartbeat_EmptyStoreIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer srv.Close()
	ok := SendOneHeartbeat(HeartbeatOptions{
		Store:     NewMemoryTokenStore(), // empty
		Path:      "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	})
	if !ok {
		t.Fatal("heartbeat with empty store should report ok")
	}
	if called {
		t.Fatal("heartbeat with empty store must not hit the network")
	}
}

func TestSendOneHeartbeat_ClearsGraceMarkerOnSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data":    map[string]any{"ok": true},
		})
	}))
	defer srv.Close()

	store := NewMemoryTokenStore()
	graceStart := int64(1_000_000)
	_ = store.Write(StoredTokenState{Token: "tok", GraceStartSec: &graceStart})

	if !SendOneHeartbeat(HeartbeatOptions{
		Store: store, Path: "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	}) {
		t.Fatal("expected success")
	}
	final, _ := store.Read()
	if final.GraceStartSec != nil {
		t.Fatalf("grace marker should have been cleared: %v", final.GraceStartSec)
	}
	if final.Token != "tok" {
		t.Fatalf("token should be preserved: %q", final.Token)
	}
}

func TestSendOneHeartbeat_ClearsStoreOnLicenseRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"error": map[string]any{
				"code":    "LicenseRevoked",
				"message": "license is revoked",
			},
		})
	}))
	defer srv.Close()

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: "soon-to-be-cleared"})

	var capturedErr error
	ok := SendOneHeartbeat(HeartbeatOptions{
		Store: store, Path: "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
		OnError:   func(e error) { capturedErr = e },
	})
	if ok {
		t.Fatal("heartbeat should have failed on revoked")
	}
	if !errors.Is(capturedErr, ErrLicenseRevoked) {
		t.Fatalf("OnError should fire LicenseRevoked, got %v", capturedErr)
	}
	final, _ := store.Read()
	if final.Token != "" {
		t.Fatalf("store must be cleared after revoke; got %q", final.Token)
	}
}

func TestSendOneHeartbeat_ClearsStoreOnLicenseSuspended(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"error": map[string]any{
				"code":    "LicenseSuspended",
				"message": "license is suspended",
			},
		})
	}))
	defer srv.Close()

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: "soon-to-be-cleared"})

	if SendOneHeartbeat(HeartbeatOptions{
		Store: store, Path: "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	}) {
		t.Fatal("heartbeat should have failed on suspended")
	}
	final, _ := store.Read()
	if final.Token != "" {
		t.Fatalf("store must be cleared after suspend; got %q", final.Token)
	}
}

func TestSendOneHeartbeat_DoesNotClearStoreOnTransientErrors(t *testing.T) {
	// IssuerUnreachable / RateLimited / network errors must NOT clear
	// the store — only revoked/suspended do, because those are
	// authoritative server-side signals.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	store := NewMemoryTokenStore()
	_ = store.Write(StoredTokenState{Token: "must-survive"})

	var capturedErr error
	if SendOneHeartbeat(HeartbeatOptions{
		Store: store, Path: "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
		OnError:   func(e error) { capturedErr = e },
	}) {
		t.Fatal("heartbeat should have failed on rate-limit")
	}
	if !errors.Is(capturedErr, ErrRateLimited) {
		t.Fatalf("expected ErrRateLimited, got %v", capturedErr)
	}
	final, _ := store.Read()
	if final.Token != "must-survive" {
		t.Fatalf("store must be preserved on rate-limit; got %q", final.Token)
	}
}

func TestSendOneHeartbeat_CASGuardAgainstParallelRefresh(t *testing.T) {
	// Simulate a parallel refresh writing a NEW token between our Read
	// and the LicenseRevoked reaction. The guard MUST detect that the
	// stored token is no longer the one we heartbeated with and skip
	// the clear, so the parallel-refresh result isn't clobbered.
	store := NewMemoryTokenStore()
	originalToken := "original-token"
	_ = store.Write(StoredTokenState{Token: originalToken})

	// Wrap the store with one that swaps the token after the first Read
	// call (which the heartbeat performs to capture state.Token).
	racingStore := &racingTokenStore{
		inner:    store,
		swapAt:   1, // swap after the heartbeat's first read
		newToken: "fresh-token-from-parallel-refresh",
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"error": map[string]any{
				"code":    "LicenseRevoked",
				"message": "license is revoked",
			},
		})
	}))
	defer srv.Close()

	if SendOneHeartbeat(HeartbeatOptions{
		Store: racingStore, Path: "/heartbeat",
		Transport: TransportOptions{BaseURL: srv.URL},
	}) {
		t.Fatal("heartbeat should have failed on revoked")
	}
	final, _ := store.Read()
	if final.Token != "fresh-token-from-parallel-refresh" {
		t.Fatalf("CAS guard failed: parallel-refresh token was clobbered; got %q",
			final.Token)
	}
	if !strings.Contains(final.Token, "fresh") {
		t.Fatal("expected fresh token to survive")
	}
}

// racingTokenStore emulates a parallel Refresh that writes a fresh
// token between the heartbeat's two Read calls. After `swapAt` reads,
// it switches the underlying state to `newToken`.
type racingTokenStore struct {
	inner    *MemoryTokenStore
	newToken string
	mu       sync.Mutex
	reads    int
	swapAt   int
}

func (s *racingTokenStore) Read() (StoredTokenState, error) {
	s.mu.Lock()
	s.reads++
	doSwap := s.reads == s.swapAt
	s.mu.Unlock()
	state, err := s.inner.Read()
	if doSwap {
		_ = s.inner.Write(StoredTokenState{Token: s.newToken})
	}
	return state, err
}

func (s *racingTokenStore) Write(state StoredTokenState) error {
	return s.inner.Write(state)
}

func (s *racingTokenStore) Clear() error {
	return s.inner.Clear()
}
