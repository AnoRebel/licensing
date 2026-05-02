// Package middleware_test exercises the framework-matrix contract:
// every adapter (chi, gin, echo) MUST emit byte-identical (status,
// body) for the same scenario. This is the Go counterpart to
// typescript/tests/middleware/matrix.test.ts; the status-code mapping
// and body shape are kept in lockstep across both ports.
package middleware_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	chiv5 "github.com/go-chi/chi/v5"
	echov5 "github.com/labstack/echo/v5"

	lic "github.com/AnoRebel/licensing/licensing"
	"github.com/AnoRebel/licensing/licensing/client"
	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/middleware"
	licensechi "github.com/AnoRebel/licensing/licensing/middleware/chi"
	licenseecho "github.com/AnoRebel/licensing/licensing/middleware/echo"
	licensegin "github.com/AnoRebel/licensing/licensing/middleware/gin"
)

// ---------- forge token (real Ed25519, deterministic across the matrix) ----------

// Mirrors the helper in licensing/easy/guard_test.go but kept here
// because that file is in package easy_test (different module).

const fpHeader = "X-Fingerprint"
const fpValue = "fp-canonical"

type forgedToken struct {
	registry *lic.AlgorithmRegistry
	bindings *lic.KeyAlgBindings
	keys     map[string]lic.KeyRecord
	token    string
}

// ---------- shared scenario builder ----------

type matrixResponse struct {
	body   map[string]any
	status int
}

type scenario struct {
	name             string
	fingerprintHdr   string // "" means omit header
	nowSec           int64
	withValidToken   bool
	withExpiredToken bool
}

// buildClient returns a fresh *easy.Client + memory store, primed per
// the scenario flags.
func buildClient(t *testing.T, sc scenario, f forgedToken) *easy.Client {
	t.Helper()
	store := client.NewMemoryTokenStore()
	if sc.withValidToken || sc.withExpiredToken {
		_ = store.Write(client.StoredTokenState{Token: f.token})
	}
	c, err := easy.NewClient(easy.ClientConfig{
		ServerURL: "https://issuer.example",
		Storage:   store,
		NowFunc:   func() int64 { return sc.nowSec },
		Verify: &easy.ClientVerifyConfig{
			Registry: f.registry,
			Bindings: f.bindings,
			Keys:     f.keys,
		},
	})
	if err != nil {
		t.Fatalf("easy.NewClient: %v", err)
	}
	return c
}

// ---------- per-framework dispatchers ----------

func dispatchChi(t *testing.T, c *easy.Client, fp string) matrixResponse {
	t.Helper()
	r := chiv5.NewRouter()
	r.Use(licensechi.LicenseMiddleware(licensechi.Config{
		Client: c,
		Fingerprint: func(req *http.Request) (string, error) {
			return req.Header.Get(fpHeader), nil
		},
	}))
	r.Get("/protected", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	if fp != "" {
		req.Header.Set(fpHeader, fp)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return decodeMatrixResponse(t, rec.Code, rec.Body.Bytes())
}

func dispatchGin(t *testing.T, c *easy.Client, fp string) matrixResponse {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(licensegin.LicenseMiddleware(licensegin.Config{
		Client: c,
		Fingerprint: func(gc *gin.Context) (string, error) {
			return gc.GetHeader(fpHeader), nil
		},
	}))
	r.GET("/protected", func(gc *gin.Context) {
		gc.JSON(http.StatusOK, gin.H{"ok": true})
	})

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	if fp != "" {
		req.Header.Set(fpHeader, fp)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return decodeMatrixResponse(t, rec.Code, rec.Body.Bytes())
}

func dispatchEcho(t *testing.T, c *easy.Client, fp string) matrixResponse {
	t.Helper()
	e := echov5.New()
	e.Use(licenseecho.LicenseMiddleware(licenseecho.Config{
		Client: c,
		Fingerprint: func(ec *echov5.Context) (string, error) {
			return ec.Request().Header.Get(fpHeader), nil
		},
	}))
	e.GET("/protected", func(ec *echov5.Context) error {
		return ec.JSON(http.StatusOK, map[string]any{"ok": true})
	})

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	if fp != "" {
		req.Header.Set(fpHeader, fp)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return decodeMatrixResponse(t, rec.Code, rec.Body.Bytes())
}

func decodeMatrixResponse(t *testing.T, status int, body []byte) matrixResponse {
	t.Helper()
	body = bytes.TrimRight(body, "\n")
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("unmarshal body %q: %v", body, err)
	}
	return matrixResponse{status: status, body: m}
}

// ---------- the matrix ----------

func TestMatrix_AllFrameworksProduceIdenticalResponses(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)

	scenarios := []scenario{
		{
			name:           "happy path",
			withValidToken: true,
			nowSec:         now,
			fingerprintHdr: fpValue,
		},
		{
			name:           "no token (empty store)",
			nowSec:         now,
			fingerprintHdr: fpValue,
		},
		{
			name:             "expired token",
			withExpiredToken: true,
			nowSec:           now + 100_000, // way past exp + skew
			fingerprintHdr:   fpValue,
		},
		{
			name:           "fingerprint mismatch",
			withValidToken: true,
			nowSec:         now,
			fingerprintHdr: "wrong-fingerprint",
		},
		{
			name:           "missing fingerprint header",
			withValidToken: true,
			nowSec:         now,
			fingerprintHdr: "",
		},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			cChi := buildClient(t, sc, f)
			cGin := buildClient(t, sc, f)
			cEcho := buildClient(t, sc, f)

			rChi := dispatchChi(t, cChi, sc.fingerprintHdr)
			rGin := dispatchGin(t, cGin, sc.fingerprintHdr)
			rEcho := dispatchEcho(t, cEcho, sc.fingerprintHdr)

			if rChi.status != rGin.status || rGin.status != rEcho.status {
				t.Errorf("status drift: chi=%d gin=%d echo=%d",
					rChi.status, rGin.status, rEcho.status)
			}
			if !bodiesEqual(rChi.body, rGin.body) || !bodiesEqual(rGin.body, rEcho.body) {
				t.Errorf("body drift:\n  chi=%v\n  gin=%v\n  echo=%v",
					rChi.body, rGin.body, rEcho.body)
			}
		})
	}
}

// ---------- per-scenario sanity checks ----------

func TestMatrix_HappyPathReturnsRouteHandlerBody(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)
	c := buildClient(t, scenario{withValidToken: true, nowSec: now}, f)
	r := dispatchChi(t, c, fpValue)
	if r.status != 200 {
		t.Fatalf("status: want 200, got %d", r.status)
	}
	if r.body["ok"] != true {
		t.Fatalf("body drift: %+v", r.body)
	}
}

func TestMatrix_NoTokenSurfaces401(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)
	c := buildClient(t, scenario{nowSec: now}, f)
	r := dispatchChi(t, c, fpValue)
	if r.status != 401 {
		t.Fatalf("status: want 401, got %d", r.status)
	}
	if r.body["error"] != "NoToken" {
		t.Fatalf("error code: want NoToken, got %v", r.body["error"])
	}
}

func TestMatrix_ExpiredSurfaces401(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)
	c := buildClient(t, scenario{withExpiredToken: true, nowSec: now + 100_000}, f)
	r := dispatchChi(t, c, fpValue)
	if r.status != 401 {
		t.Fatalf("status: want 401, got %d", r.status)
	}
	if r.body["error"] != "TokenExpired" {
		t.Fatalf("error code: want TokenExpired, got %v", r.body["error"])
	}
}

func TestMatrix_FingerprintMismatchSurfaces403(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)
	c := buildClient(t, scenario{withValidToken: true, nowSec: now}, f)
	r := dispatchChi(t, c, "wrong-fp")
	if r.status != 403 {
		t.Fatalf("status: want 403, got %d", r.status)
	}
	if r.body["error"] != "FingerprintMismatch" {
		t.Fatalf("error code: want FingerprintMismatch, got %v", r.body["error"])
	}
}

func TestMatrix_MissingFingerprintSurfaces400(t *testing.T) {
	now := int64(2_000_000_000)
	f := forgeFreshToken(t, fpValue, now)
	c := buildClient(t, scenario{withValidToken: true, nowSec: now}, f)
	r := dispatchChi(t, c, "")
	if r.status != 400 {
		t.Fatalf("status: want 400, got %d", r.status)
	}
	if r.body["error"] != "MissingFingerprint" {
		t.Fatalf("error code: want MissingFingerprint, got %v", r.body["error"])
	}
}

// ---------- BuildGuardError unit coverage ----------
//
// The status-code map is what guarantees parity. Hit each row directly.

func TestBuildGuardError_StatusCodeMap(t *testing.T) {
	cases := []struct {
		code   client.ClientErrorCode
		status int
	}{
		{client.CodeNoToken, 401},
		{client.CodeTokenExpired, 401},
		{client.CodeTokenNotYetValid, 401},
		{client.CodeTokenReplayed, 401},
		{client.CodeFingerprintMismatch, 403},
		{client.CodeAudienceMismatch, 403},
		{client.CodeIssuerMismatch, 403},
		{client.CodeLicenseRevoked, 403},
		{client.CodeLicenseSuspended, 403},
		{client.CodeGraceExpired, 403},
		{client.CodeRequiresOnlineRefresh, 403},
		{client.CodeInvalidLicenseKey, 404},
		{client.CodeUnknownKid, 404},
		{client.CodeUnsupportedAlgorithm, 422},
		{client.CodeAlgorithmMismatch, 422},
		{client.CodeRateLimited, 429},
		{client.CodeIssuerProtocolError, 502},
		{client.CodeIssuerUnreachable, 503},
	}
	for _, tc := range cases {
		t.Run(string(tc.code), func(t *testing.T) {
			err := &client.ClientError{Code: tc.code, Message: "x"}
			s, body := middleware.BuildGuardError(err)
			if s != tc.status {
				t.Fatalf("status: want %d, got %d", tc.status, s)
			}
			if body.Error != string(tc.code) {
				t.Fatalf("error: want %s, got %s", tc.code, body.Error)
			}
		})
	}
}
