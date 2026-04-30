package easy_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/easy"
)

// healthDisambigServer composes responders for /refresh and /health on
// the same test server so the high-level client probe and refresh
// primitive both target one BaseURL.
type healthDisambigOpts struct {
	refreshResponder func(w http.ResponseWriter, r *http.Request)
	healthResponder  func(w http.ResponseWriter, r *http.Request)
}

func mkHealthDisambigServer(t *testing.T, o healthDisambigOpts) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	if o.refreshResponder != nil {
		mux.HandleFunc("/api/licensing/v1/refresh", o.refreshResponder)
	}
	if o.healthResponder != nil {
		mux.HandleFunc("/api/licensing/v1/health", o.healthResponder)
	}
	return httptest.NewServer(mux)
}

func writeHealthOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"data": map[string]any{
			"status":  "ok",
			"version": "0.1.0",
			"time":    time.Now().UTC().Format(time.RFC3339),
		},
	})
}

func writeHealth503(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"data": map[string]any{
			"status":  "error",
			"version": "0.1.0",
			"time":    time.Now().UTC().Format(time.RFC3339),
		},
	})
}

// failingRefresh returns 503 plain text — the transport's JSON-parse
// fallback maps non-JSON 5xx responses to ClientError(IssuerUnreachable),
// matching the "/refresh route is broken" scenario.
func failingRefresh(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "down", http.StatusServiceUnavailable)
}

func TestRefresh_HealthOKAndRefreshFail_ProtocolError(t *testing.T) {
	now := int64(2_000_000_000)
	foa := now - 100
	f := forgeToken(t, forgeOpts{
		NowSec:           now,
		UsageFingerprint: "fp-1",
		ForceOnlineAfter: &foa,
	})

	srv := mkHealthDisambigServer(t, healthDisambigOpts{
		refreshResponder: failingRefresh,
		healthResponder: func(w http.ResponseWriter, _ *http.Request) {
			writeHealthOK(w)
		},
	})
	defer srv.Close()

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
		GracePeriodSec: 7 * 86_400,
		GracePeriodSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	out, err := c.Refresh()
	if err == nil {
		t.Fatalf("expected error, got outcome: %+v", out)
	}
	var ce *client.ClientError
	if !errors.As(err, &ce) || ce.Code != client.CodeIssuerProtocolError {
		t.Fatalf("want IssuerProtocolError, got %v", err)
	}

	// Grace marker must NOT have been persisted — disambiguation rolled
	// it back because /health proved the issuer is up.
	after, _ := store.Read()
	if after.GraceStartSec != nil {
		t.Fatalf("grace marker should be rolled back; got %d", *after.GraceStartSec)
	}
}

func TestRefresh_HealthFailAndRefreshFail_GraceEntered(t *testing.T) {
	now := int64(2_000_000_000)
	foa := now - 100
	f := forgeToken(t, forgeOpts{
		NowSec:           now,
		UsageFingerprint: "fp-1",
		ForceOnlineAfter: &foa,
	})

	srv := mkHealthDisambigServer(t, healthDisambigOpts{
		refreshResponder: failingRefresh,
		healthResponder: func(w http.ResponseWriter, _ *http.Request) {
			// Hijack the connection to drop the request mid-flight,
			// producing a transport-level error on the probe.
			hj, ok := w.(http.Hijacker)
			if !ok {
				http.Error(w, "no hijacker", http.StatusInternalServerError)
				return
			}
			conn, _, hjErr := hj.Hijack()
			if hjErr != nil {
				return
			}
			_ = conn.Close()
		},
	})
	defer srv.Close()

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
		GracePeriodSec: 7 * 86_400,
		GracePeriodSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	out, err := c.Refresh()
	if err != nil {
		t.Fatalf("expected outcome, got error: %v", err)
	}
	if out.Kind != client.RefreshKindGraceEntered {
		t.Fatalf("want grace-entered, got %s", out.Kind)
	}
	after, _ := store.Read()
	if after.GraceStartSec == nil || *after.GraceStartSec != now {
		t.Fatalf("grace marker should be persisted at %d; got %v", now, after.GraceStartSec)
	}
}

func TestRefresh_Health503AndRefreshFail_GraceEntered(t *testing.T) {
	now := int64(2_000_000_000)
	foa := now - 100
	f := forgeToken(t, forgeOpts{
		NowSec:           now,
		UsageFingerprint: "fp-1",
		ForceOnlineAfter: &foa,
	})

	srv := mkHealthDisambigServer(t, healthDisambigOpts{
		refreshResponder: failingRefresh,
		healthResponder: func(w http.ResponseWriter, _ *http.Request) {
			writeHealth503(w)
		},
	})
	defer srv.Close()

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
		GracePeriodSec: 7 * 86_400,
		GracePeriodSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	out, err := c.Refresh()
	if err != nil {
		t.Fatalf("expected outcome, got error: %v", err)
	}
	if out.Kind != client.RefreshKindGraceEntered {
		t.Fatalf("want grace-entered, got %s", out.Kind)
	}
	after, _ := store.Read()
	if after.GraceStartSec == nil {
		t.Fatalf("grace marker should be persisted; got nil")
	}
}

// Sanity guard against the test helpers diverging from production wiring:
// the probe URL must be ${BaseURL}${pathPrefix}/health. If we ever change
// the prefix, this canary will catch it before the disambig tests pass for
// the wrong reason.
func TestRefresh_DisambigUsesPrefixedHealthURL(t *testing.T) {
	now := int64(2_000_000_000)
	foa := now - 100
	f := forgeToken(t, forgeOpts{
		NowSec:           now,
		UsageFingerprint: "fp-1",
		ForceOnlineAfter: &foa,
	})

	var probedURL string
	srv := mkHealthDisambigServer(t, healthDisambigOpts{
		refreshResponder: failingRefresh,
		healthResponder: func(w http.ResponseWriter, r *http.Request) {
			probedURL = r.URL.Path
			writeHealthOK(w)
		},
	})
	defer srv.Close()

	store := client.NewMemoryTokenStore()
	_ = store.Write(client.StoredTokenState{Token: f.Token})

	c, _ := easy.NewClient(easy.ClientConfig{
		ServerURL: srv.URL,
		Storage:   store,
		Transport: client.TransportOptions{BaseURL: srv.URL},
		NowFunc:   func() int64 { return now },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.Registry, Bindings: f.Bindings, Keys: f.Keys,
		},
	})
	_, _ = c.Refresh()
	if !strings.HasSuffix(probedURL, "/api/licensing/v1/health") {
		t.Fatalf("probe URL drift: %q", probedURL)
	}
}
