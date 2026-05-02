// Package echo provides a license-guard middleware for labstack/echo v5.
//
// Usage:
//
//	import (
//		"github.com/labstack/echo/v5"
//		"github.com/AnoRebel/licensing/licensing/easy"
//		licenseecho "github.com/AnoRebel/licensing/licensing/middleware/echo"
//	)
//
//	e := echo.New()
//	c, _ := easy.NewClient(easy.ClientConfig{ ... })
//	e.Use(licenseecho.LicenseMiddleware(licenseecho.Config{
//		Client: c,
//		Fingerprint: func(c *echo.Context) (string, error) {
//			return c.Request().Header.Get("X-Fingerprint"), nil
//		},
//	}))
//
//	e.GET("/protected", func(c *echo.Context) error {
//		handle, _ := licenseecho.LicenseFrom(c)
//		return c.JSON(200, map[string]any{"licenseId": handle.LicenseID})
//	})
//
// Errors are emitted via c.JSON; the body shape and status-code mapping
// live in the shared core package.
//
// Note: this adapter targets echo v5 (Context is a struct, HandlerFunc
// is `func(c *Context) error`). It is NOT compatible with echo v4 — the
// Context interface and method set differ.
package echo

import (
	echov5 "github.com/labstack/echo/v5"

	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/middleware"
)

// Config carries the echo-specific configuration for LicenseMiddleware.
type Config struct {
	// Client is a pre-constructed *easy.Client.
	Client *easy.Client
	// Fingerprint extracts the device fingerprint from the *echo.Context.
	// Returning "" or an error short-circuits with 400 MissingFingerprint.
	Fingerprint middleware.FingerprintExtractor[*echov5.Context]
	// OnSuccess fires when the guard succeeds. Optional. Errors surface
	// as 500 InternalError.
	OnSuccess middleware.OnSuccessHook[*echov5.Context]
}

// licenseEchoKey is the echo-context key under which the LicenseHandle
// is stored. Consumers should call LicenseFrom rather than c.Get.
const licenseEchoKey = "anorebel.licensing.handle"

// LicenseMiddleware returns an echo MiddlewareFunc that runs
// easy.Client.Guard on every request. On success it stores the
// LicenseHandle under licenseEchoKey via c.Set and calls next. On
// failure it emits the canonical JSON response and returns nil
// (echo's middleware contract: returning nil after writing the
// response stops the chain).
func LicenseMiddleware(cfg Config) echov5.MiddlewareFunc {
	core := middleware.LicenseGuardConfig{Client: cfg.Client}
	return func(next echov5.HandlerFunc) echov5.HandlerFunc {
		return func(c *echov5.Context) error {
			result := middleware.RunGuard(c, core, cfg.Fingerprint, cfg.OnSuccess)
			if !result.OK {
				// c.JSON writes the response and commits — echo's
				// chain stops once the response is committed without
				// us needing to throw an error.
				return c.JSON(result.Status, result.Body)
			}
			c.Set(licenseEchoKey, result.Handle)
			return next(c)
		}
	}
}

// LicenseFrom returns the LicenseHandle attached by LicenseMiddleware,
// or (nil, false) if it wasn't run for this request.
func LicenseFrom(c *echov5.Context) (*easy.LicenseHandle, bool) {
	v := c.Get(licenseEchoKey)
	if v == nil {
		return nil, false
	}
	handle, ok := v.(*easy.LicenseHandle)
	return handle, ok
}
