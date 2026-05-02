// Package chi provides a license-guard middleware for go-chi/chi v5.
//
// Usage:
//
//	import (
//		"github.com/go-chi/chi/v5"
//		"github.com/AnoRebel/licensing/licensing/easy"
//		licensechi "github.com/AnoRebel/licensing/licensing/middleware/chi"
//	)
//
//	r := chi.NewRouter()
//	c, _ := easy.NewClient(easy.ClientConfig{ ... })
//	r.Use(licensechi.LicenseMiddleware(licensechi.Config{
//		Client: c,
//		Fingerprint: func(r *http.Request) (string, error) {
//			return r.Header.Get("X-Fingerprint"), nil
//		},
//	}))
//
//	r.Get("/protected", func(w http.ResponseWriter, r *http.Request) {
//		// LicenseFromContext returns the handle attached by the middleware.
//		handle := licensechi.LicenseFromContext(r.Context())
//		fmt.Fprintf(w, "license: %s", handle.LicenseID)
//	})
//
// Errors are emitted as JSON with the canonical body shape (`{"error":
// <code>, "message": ...}`); the status-code mapping lives in the
// shared core package.
package chi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/middleware"
)

// Config carries the chi-specific configuration for LicenseMiddleware.
type Config struct {
	// Client is a pre-constructed *easy.Client.
	Client *easy.Client
	// Fingerprint extracts the device fingerprint from the inbound
	// *http.Request. Common shapes:
	//   func(r *http.Request) (string, error) { return r.Header.Get("X-Fingerprint"), nil }
	//   func(r *http.Request) (string, error) { return readFingerprintCookie(r) }
	// Returning "" or an error short-circuits with 400 MissingFingerprint.
	Fingerprint middleware.FingerprintExtractor[*http.Request]
	// OnSuccess fires when the guard succeeds. Optional. Errors from
	// the hook surface as 500 InternalError.
	OnSuccess middleware.OnSuccessHook[*http.Request]
}

// licenseCtxKey is the unexported key under which the LicenseHandle is
// attached to the request context. Unexported so callers can't read or
// write it directly — they MUST go through LicenseFromContext.
type licenseCtxKey struct{}

// LicenseMiddleware returns a chi-compatible middleware that runs
// easy.Client.Guard on every request. On success it attaches the
// resolved LicenseHandle to the request context (retrievable via
// LicenseFromContext). On failure it writes a JSON error response with
// the canonical status code and body shape, and does NOT call next.
func LicenseMiddleware(cfg Config) func(next http.Handler) http.Handler {
	core := middleware.LicenseGuardConfig{Client: cfg.Client}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			result := middleware.RunGuard(r, core, cfg.Fingerprint, cfg.OnSuccess)
			if !result.OK {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(result.Status)
				_ = json.NewEncoder(w).Encode(result.Body)
				return
			}
			ctx := context.WithValue(r.Context(), licenseCtxKey{}, result.Handle)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// LicenseFromContext returns the LicenseHandle attached by
// LicenseMiddleware. Returns nil if the middleware did not run for this
// request — handlers that depend on the handle should treat nil as
// "the middleware was misconfigured" rather than a recoverable state.
func LicenseFromContext(ctx context.Context) *easy.LicenseHandle {
	v, _ := ctx.Value(licenseCtxKey{}).(*easy.LicenseHandle)
	return v
}
