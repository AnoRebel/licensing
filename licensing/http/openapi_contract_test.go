package http

import (
	"bytes"
	"context"
	stdsql "database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"
	_ "modernc.org/sqlite"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	"github.com/AnoRebel/licensing/licensing/storage/memory"
	"github.com/AnoRebel/licensing/licensing/storage/postgres"
	"github.com/AnoRebel/licensing/licensing/storage/sqlite"
)

// OpenAPI contract-conformance suite.
//
// Loads openapi/licensing-admin.yaml, seeds a full scope+keys+license
// graph on each supported backend, hits every representative endpoint,
// and asserts the response body validates against the OpenAPI envelope
// schema. Drift between a handler's wire shape and the OpenAPI
// ...Envelope schema fails the build.
//
// Backend matrix:
//   - memory   — always.
//   - sqlite   — always (in-memory DB).
//   - postgres — opt-in via LICENSING_PG_URL; each test run uses its own
//                schema so parallel runs don't clobber each other.

// ---------- spec loading ----------

func loadSpecOrSkip(t *testing.T) *openAPIDoc {
	t.Helper()
	// licensing-admin.yaml lives at the monorepo root: <repo>/openapi/.
	// The tests run from <repo>/licensing/http so we walk up two dirs.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// licensing/http → licensing → <repo>
	repoRoot := filepath.Join(wd, "..", "..")
	specPath := filepath.Join(repoRoot, "openapi", "licensing-admin.yaml")
	data, err := os.ReadFile(specPath)
	if err != nil {
		t.Skipf("openapi spec not found at %s — skipping conformance suite (%v)", specPath, err)
	}
	var parsed any
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("parse openapi yaml: %v", err)
	}
	parsed = normalizeYAML(parsed)
	doc, err := newOpenAPIDoc(parsed)
	if err != nil {
		t.Fatalf("parse openapi doc: %v", err)
	}
	return doc
}

// normalizeYAML converts yaml.v3's map[any]any / []any into the
// map[string]any shape the validator expects.
func normalizeYAML(v any) any {
	switch x := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(x))
		for k, vv := range x {
			out[fmt.Sprintf("%v", k)] = normalizeYAML(vv)
		}
		return out
	case map[string]any:
		for k, vv := range x {
			x[k] = normalizeYAML(vv)
		}
		return x
	case []any:
		for i, vv := range x {
			x[i] = normalizeYAML(vv)
		}
		return x
	}
	return v
}

// ---------- backends ----------

type conformBackend struct {
	make func(t *testing.T) (lic.Storage, func())
	name string
}

func allBackends(t *testing.T) []conformBackend {
	t.Helper()
	backends := []conformBackend{
		{
			name: "memory",
			make: func(t *testing.T) (lic.Storage, func()) {
				return memory.New(memory.Options{}), func() {}
			},
		},
		{
			name: "sqlite",
			make: func(t *testing.T) (lic.Storage, func()) {
				db, err := stdsql.Open("sqlite", ":memory:")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := sqlite.ApplyMigrations(db); err != nil {
					t.Fatal(err)
				}
				s, err := sqlite.NewFromDB(db, sqlite.Options{})
				if err != nil {
					t.Fatal(err)
				}
				return s, func() { _ = db.Close() }
			},
		},
	}
	if pgURL := os.Getenv("LICENSING_PG_URL"); pgURL != "" {
		backends = append(backends, conformBackend{
			name: "postgres",
			make: func(t *testing.T) (lic.Storage, func()) {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				schema := fmt.Sprintf("t_%d", time.Now().UnixNano())
				// Master pool: create the schema.
				master, err := pgxpool.New(ctx, pgURL)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := master.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA "%s"`, schema)); err != nil {
					master.Close()
					t.Fatal(err)
				}
				master.Close()

				// Worker pool: scoped to the schema via search_path.
				cfg, err := pgxpool.ParseConfig(pgURL)
				if err != nil {
					t.Fatal(err)
				}
				if cfg.ConnConfig.RuntimeParams == nil {
					cfg.ConnConfig.RuntimeParams = map[string]string{}
				}
				cfg.ConnConfig.RuntimeParams["search_path"] = schema
				pool, err := pgxpool.NewWithConfig(ctx, cfg)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := postgres.ApplyMigrations(ctx, pool); err != nil {
					pool.Close()
					t.Fatal(err)
				}
				s := postgres.New(pool, postgres.Options{})
				cleanup := func() {
					pool.Close()
					m, err := pgxpool.New(context.Background(), pgURL)
					if err != nil {
						return
					}
					defer m.Close()
					_, _ = m.Exec(context.Background(), fmt.Sprintf(`DROP SCHEMA "%s" CASCADE`, schema))
				}
				return s, cleanup
			},
		})
	}
	return backends
}

// ---------- seed helper ----------

type conformSeed struct {
	scopeID    string
	license    *lic.License
	signingID  string
	signingKid string
}

func seedConformance(t *testing.T, storage lic.Storage, clk lic.Clock, reg *lic.AlgorithmRegistry, rootPass, sigPass string) conformSeed {
	t.Helper()
	scope, err := lic.CreateScope(storage, clk, lic.CreateScopeInput{
		Slug: "acme", Name: "Acme Corp",
	}, lic.CreateScopeOptions{})
	if err != nil {
		t.Fatalf("CreateScope: %v", err)
	}
	root, err := lic.GenerateRootKey(storage, clk, reg, lic.GenerateRootKeyInput{
		Alg: lic.AlgEd25519, Passphrase: rootPass, ScopeID: &scope.ID,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}
	signing, err := lic.IssueInitialSigningKey(storage, clk, reg, lic.IssueInitialSigningKeyInput{
		Alg: lic.AlgEd25519, RootKid: root.Kid, ScopeID: &scope.ID,
		RootPassphrase: rootPass, SigningPassphrase: sigPass,
	}, lic.KeyIssueOptions{})
	if err != nil {
		t.Fatalf("IssueInitialSigningKey: %v", err)
	}
	license, err := lic.CreateLicense(storage, clk, lic.CreateLicenseInput{
		ScopeID:        &scope.ID,
		LicensableType: "User", LicensableID: "u-1",
		MaxUsages: 3, Status: lic.LicenseStatusActive,
	}, lic.CreateLicenseOptions{})
	if err != nil {
		t.Fatalf("CreateLicense: %v", err)
	}
	return conformSeed{
		scopeID: scope.ID, license: license,
		signingID: signing.ID, signingKid: signing.Kid,
	}
}

// ---------- helpers ----------

const specPrefix = "/api/licensing/v1"

func doRequest(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
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
	h.ServeHTTP(rec, req)
	return rec
}

func expectEnvelope(t *testing.T, doc *openAPIDoc, envelopeName string, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Body.Len() == 0 {
		t.Fatalf("envelope %q: empty body (status=%d)", envelopeName, rec.Code)
	}
	var body any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("envelope %q: decode: %v; body=%s", envelopeName, err, rec.Body.String())
	}
	errs := doc.validate(doc.schema(envelopeName), body, "")
	if len(errs) > 0 {
		t.Fatalf("envelope %q validation failed:\n%s\nbody=%s", envelopeName, joinErrors(errs), rec.Body.String())
	}
}

// ---------- test matrix ----------

func TestOpenAPIContractConformance(t *testing.T) {
	doc := loadSpecOrSkip(t)
	for _, b := range allBackends(t) {
		b := b
		t.Run(b.name, func(t *testing.T) {
			t.Parallel()
			runContractSuite(t, doc, b)
		})
	}
}

func runContractSuite(t *testing.T, doc *openAPIDoc, b conformBackend) {
	t.Helper()

	// Shared registry/clock so all subtests use identical crypto state.
	clk := fixedClock{now: "2026-06-01T00:00:00Z"}
	reg := lic.NewAlgorithmRegistry()
	if err := reg.Register(ed.New()); err != nil {
		t.Fatal(err)
	}

	newAdmin := func(s lic.Storage) http.Handler {
		return NewAdminHandler(&AdminContext{
			Storage: s, Clock: clk, Backends: reg,
			Version:           "test",
			RootPassphrase:    "root-pw",
			SigningPassphrase: "sign-pw",
		}, specPrefix)
	}
	newClient := func(s lic.Storage) http.Handler {
		return NewClientHandler(&ClientContext{
			Storage: s, Clock: clk, Backends: reg,
			Version:           "test",
			SigningPassphrase: "sign-pw",
		}, specPrefix)
	}

	type testCase struct {
		run  func(t *testing.T, s lic.Storage)
		name string
	}

	cases := []testCase{
		// ---------- Client ----------
		{
			name: "GET_health_HealthEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newClient(s), http.MethodGet, specPrefix+"/health", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "HealthEnvelope", rec)
			},
		},
		{
			name: "GET_health_503_HealthEnvelope_on_storage_failure",
			run: func(t *testing.T, s lic.Storage) {
				// Wrap storage so ListAudit fails — flips /health into the
				// 503 + status=error branch. Schema still validates because
				// HealthEnvelope.status enum permits both ok and error.
				wrapped := failingStorage{Storage: s}
				h := NewClientHandler(&ClientContext{
					Storage: wrapped, Clock: clk, Backends: reg,
					Version:           "test",
					SigningPassphrase: "sign-pw",
				}, specPrefix)
				rec := doRequest(t, h, http.MethodGet, specPrefix+"/health", nil)
				if rec.Code != http.StatusServiceUnavailable {
					t.Fatalf("want 503, got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "HealthEnvelope", rec)
			},
		},
		{
			name: "POST_activate_unknown_license_ErrorEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newClient(s), http.MethodPost, specPrefix+"/activate", map[string]any{
					"license_key": "LIC-NOPE-NOPE-NOPE",
					"fingerprint": strings.Repeat("a", 64),
				})
				if rec.Code != http.StatusNotFound {
					t.Fatalf("want 404, got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "ErrorEnvelope", rec)
			},
		},
		{
			name: "POST_activate_happy_TokenEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newClient(s), http.MethodPost, specPrefix+"/activate", map[string]any{
					"license_key": seed.license.LicenseKey,
					"fingerprint": strings.Repeat("b", 64),
				})
				if rec.Code != http.StatusOK {
					t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "TokenEnvelope", rec)
			},
		},
		// ---------- Admin: licenses ----------
		{
			name: "GET_admin_licenses_list_LicenseListEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				_ = seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/licenses", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "LicenseListEnvelope", rec)
			},
		},
		{
			name: "GET_admin_licenses_item_LicenseEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/licenses/"+seed.license.ID, nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "LicenseEnvelope", rec)
			},
		},
		{
			name: "GET_admin_licenses_item_missing_ErrorEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newAdmin(s), http.MethodGet,
					specPrefix+"/admin/licenses/01900000-0000-7000-8000-000000000000", nil)
				if rec.Code != http.StatusNotFound {
					t.Fatalf("want 404 got %d", rec.Code)
				}
				expectEnvelope(t, doc, "ErrorEnvelope", rec)
			},
		},
		{
			name: "POST_admin_licenses_create_LicenseEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodPost, specPrefix+"/admin/licenses", map[string]any{
					"scope_id":        seed.scopeID,
					"licensable_type": "Team",
					"licensable_id":   "t-42",
					"max_usages":      5,
				})
				if rec.Code != http.StatusCreated {
					t.Fatalf("want 201 got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "LicenseEnvelope", rec)
			},
		},
		{
			name: "POST_admin_licenses_suspend_LicenseEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				// License seeded as active — suspend should transition to suspended.
				rec := doRequest(t, newAdmin(s), http.MethodPost,
					specPrefix+"/admin/licenses/"+seed.license.ID+"/suspend", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("want 200 got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "LicenseEnvelope", rec)
			},
		},
		// ---------- Admin: scopes ----------
		{
			name: "GET_admin_scopes_list_ScopeListEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				_ = seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/scopes", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "ScopeListEnvelope", rec)
			},
		},
		{
			name: "POST_admin_scopes_create_ScopeEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newAdmin(s), http.MethodPost, specPrefix+"/admin/scopes", map[string]any{
					"slug": "widget-co",
					"name": "Widget Co",
				})
				if rec.Code != http.StatusCreated {
					t.Fatalf("want 201 got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "ScopeEnvelope", rec)
			},
		},
		{
			name: "GET_admin_scopes_item_ScopeEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/scopes/"+seed.scopeID, nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "ScopeEnvelope", rec)
			},
		},
		// ---------- Admin: templates ----------
		{
			name: "GET_admin_templates_list_TemplateListEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				_ = seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/templates", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "TemplateListEnvelope", rec)
			},
		},
		{
			name: "POST_admin_templates_create_TemplateEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodPost, specPrefix+"/admin/templates", map[string]any{
					"scope_id":           seed.scopeID,
					"name":               "Pro Plan",
					"max_usages":         10,
					"trial_duration_sec": 0,
					"grace_duration_sec": 86400,
					"entitlements":       map[string]any{"features": []string{"a", "b"}},
				})
				if rec.Code != http.StatusCreated {
					t.Fatalf("want 201 got %d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "TemplateEnvelope", rec)
			},
		},
		// ---------- Admin: usages ----------
		{
			name: "GET_admin_usages_list_UsageListEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				if _, err := lic.RegisterUsage(s, clk, lic.RegisterUsageInput{
					LicenseID:   seed.license.ID,
					Fingerprint: strings.Repeat("d", 64),
				}, lic.RegisterUsageOptions{}); err != nil {
					t.Fatalf("RegisterUsage: %v", err)
				}
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/usages", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "UsageListEnvelope", rec)
			},
		},
		// ---------- Admin: keys ----------
		{
			name: "GET_admin_keys_KeyListEnvelope_noPrivatePem",
			run: func(t *testing.T, s lic.Storage) {
				_ = seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/keys", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "KeyListEnvelope", rec)
				// Extra guard beyond schema: no item leaks the encrypted private key.
				var decoded struct {
					Data struct {
						Items []map[string]any `json:"items"`
					} `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
					t.Fatal(err)
				}
				for _, item := range decoded.Data.Items {
					if _, leaked := item["private_pem_enc"]; leaked {
						t.Fatal("private_pem_enc leaked in key list")
					}
				}
			},
		},
		{
			name: "POST_admin_keys_rotate_RotateKeyEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				seed := seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodPost,
					specPrefix+"/admin/keys/"+seed.signingID+"/rotate", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
				expectEnvelope(t, doc, "RotateKeyEnvelope", rec)
			},
		},
		// ---------- Admin: audit ----------
		{
			name: "GET_admin_audit_AuditListEnvelope",
			run: func(t *testing.T, s lic.Storage) {
				_ = seedConformance(t, s, clk, reg, "root-pw", "sign-pw")
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/audit", nil)
				if rec.Code != http.StatusOK {
					t.Fatalf("status=%d", rec.Code)
				}
				expectEnvelope(t, doc, "AuditListEnvelope", rec)
			},
		},
		// ---------- Router-level negatives ----------
		{
			name: "unknown_path_ErrorEnvelope_404",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newAdmin(s), http.MethodGet, specPrefix+"/admin/nope", nil)
				if rec.Code != http.StatusNotFound {
					t.Fatalf("want 404 got %d", rec.Code)
				}
				expectEnvelope(t, doc, "ErrorEnvelope", rec)
			},
		},
		{
			name: "wrong_method_ErrorEnvelope_405",
			run: func(t *testing.T, s lic.Storage) {
				rec := doRequest(t, newAdmin(s), http.MethodDelete, specPrefix+"/admin/audit", nil)
				if rec.Code != http.StatusMethodNotAllowed {
					t.Fatalf("want 405 got %d", rec.Code)
				}
				expectEnvelope(t, doc, "ErrorEnvelope", rec)
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			s, cleanup := b.make(t)
			defer cleanup()
			tc.run(t, s)
		})
	}
}
