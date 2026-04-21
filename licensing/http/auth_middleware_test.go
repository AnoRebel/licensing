package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// echoHandler replies with the Principal from context (if any) so tests can
// assert what the middleware propagated.
func echoHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFromContext(r.Context())
		if !ok {
			http.Error(w, "no principal", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subject": p.Subject,
			"roles":   p.Roles,
		})
	})
}

func decodeErrorEnvelope(t *testing.T, body io.Reader) Envelope {
	t.Helper()
	var env Envelope
	if err := json.NewDecoder(body).Decode(&env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	return env
}

func TestBearerAuth_MissingHeader(t *testing.T) {
	h := BearerAuth(StaticBearerVerifier(strings.Repeat("a", 32), Principal{Subject: "admin"}), echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rr.Code)
	}
	env := decodeErrorEnvelope(t, rr.Body)
	if env.Success || env.Error == nil || env.Error.Code != "Unauthenticated" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
}

func TestBearerAuth_MalformedHeader(t *testing.T) {
	cases := []string{
		"tokenonly",  // no scheme
		"Basic abcd", // wrong scheme
		"Bearer",     // missing token
		"Bearer  ",   // whitespace-only token
		"bearer",     // scheme without token, case-insensitive
	}
	h := BearerAuth(StaticBearerVerifier(strings.Repeat("a", 32), Principal{Subject: "admin"}), echoHandler())
	for _, header := range cases {
		t.Run(header, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			req.Header.Set("Authorization", header)
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("want 401 for %q, got %d", header, rr.Code)
			}
		})
	}
}

func TestBearerAuth_CaseInsensitiveScheme(t *testing.T) {
	tok := strings.Repeat("a", 32)
	h := BearerAuth(StaticBearerVerifier(tok, Principal{Subject: "admin"}), echoHandler())
	for _, scheme := range []string{"Bearer", "bearer", "BEARER", "BeArEr"} {
		t.Run(scheme, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			req.Header.Set("Authorization", scheme+" "+tok)
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Fatalf("want 200 for scheme %q, got %d body=%s", scheme, rr.Code, rr.Body.String())
			}
		})
	}
}

func TestBearerAuth_InvalidToken(t *testing.T) {
	h := BearerAuth(StaticBearerVerifier(strings.Repeat("c", 32), Principal{Subject: "admin"}), echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+strings.Repeat("w", 32))
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rr.Code)
	}
	env := decodeErrorEnvelope(t, rr.Body)
	if env.Error == nil || env.Error.Code != "Unauthenticated" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
}

func TestBearerAuth_HappyPath_PropagatesPrincipal(t *testing.T) {
	want := Principal{Subject: "admin:42", Roles: []string{"root", "ops"}}
	secret := strings.Repeat("s", 48)
	h := BearerAuth(StaticBearerVerifier(secret, want), echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var got struct {
		Subject string   `json:"subject"`
		Roles   []string `json:"roles"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Subject != want.Subject {
		t.Fatalf("subject: want %q got %q", want.Subject, got.Subject)
	}
	if strings.Join(got.Roles, ",") != strings.Join(want.Roles, ",") {
		t.Fatalf("roles: want %v got %v", want.Roles, got.Roles)
	}
}

func TestBearerAuth_VerifierErrorIs500(t *testing.T) {
	boom := errors.New("db down")
	verifier := func(_ context.Context, _ string) (Principal, error) {
		return Principal{}, boom
	}
	h := BearerAuth(verifier, echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer anything")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", rr.Code)
	}
	env := decodeErrorEnvelope(t, rr.Body)
	if env.Error == nil || env.Error.Code != "InternalError" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
}

func TestBearerAuth_ErrInvalidBearerWrappedIs401(t *testing.T) {
	// Custom verifier that wraps ErrInvalidBearer should still 401 via errors.Is.
	wrapped := func(_ context.Context, _ string) (Principal, error) {
		return Principal{}, &wrappedErr{inner: ErrInvalidBearer, msg: "token expired"}
	}
	h := BearerAuth(wrapped, echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer anything")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rr.Code)
	}
}

func TestBearerAuth_EmptySubjectIs500(t *testing.T) {
	// A verifier that returns success but empty Subject is a misconfig.
	verifier := func(_ context.Context, _ string) (Principal, error) {
		return Principal{Subject: ""}, nil
	}
	h := BearerAuth(verifier, echoHandler())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer anything")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", rr.Code)
	}
}

func TestBearerAuth_NilVerifierPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on nil verifier")
		}
	}()
	BearerAuth(nil, echoHandler())
}

func TestBearerAuth_NilNextPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on nil next")
		}
	}()
	BearerAuth(StaticBearerVerifier(strings.Repeat("a", 32), Principal{Subject: "x"}), nil)
}

func TestStaticBearerVerifier_PanicsOnEmpty(t *testing.T) {
	t.Run("empty-token", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		StaticBearerVerifier("", Principal{Subject: "x"})
	})
	t.Run("empty-subject", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		StaticBearerVerifier(strings.Repeat("a", 32), Principal{})
	})
	t.Run("short-token", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic on under-32-byte token")
			}
		}()
		StaticBearerVerifier(strings.Repeat("a", 31), Principal{Subject: "x"})
	})
}

func TestBearerAuth_RejectsNonToken68Bytes(t *testing.T) {
	// Tokens containing bytes outside 0x21..0x7E (CR/LF/NUL/high-bit) must be
	// refused by extractBearer before they can reach the verifier — this
	// blocks CR/LF injection and keeps the raw header fenced off downstream.
	valid := strings.Repeat("v", 32)
	h := BearerAuth(StaticBearerVerifier(valid, Principal{Subject: "admin"}), echoHandler())

	// Build the Authorization value manually to dodge any header normalization
	// Go's net/http might apply to a Header.Set() call.
	cases := []string{
		"Bearer " + strings.Repeat("a", 31) + "\x00", // NUL
		"Bearer " + strings.Repeat("a", 31) + "\x01", // control
		"Bearer " + strings.Repeat("a", 31) + "\x7f", // DEL
		"Bearer " + strings.Repeat("a", 31) + "\xff", // high-bit
	}
	for _, v := range cases {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header["Authorization"] = []string{v}
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("%q: want 401, got %d", v, rr.Code)
		}
	}
}

func TestPrincipalFromContext_Absent(t *testing.T) {
	p, ok := PrincipalFromContext(context.Background())
	if ok {
		t.Fatalf("expected ok=false, got principal=%+v", p)
	}
}

// wrappedErr is a minimal fixture for errors.Is wrapping in tests.
type wrappedErr struct {
	inner error
	msg   string
}

func (w *wrappedErr) Error() string { return w.msg + ": " + w.inner.Error() }
func (w *wrappedErr) Unwrap() error { return w.inner }
