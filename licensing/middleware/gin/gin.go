// Package gin provides a license-guard middleware for gin-gonic/gin.
//
// Usage:
//
//	import (
//		"github.com/gin-gonic/gin"
//		"github.com/AnoRebel/licensing/licensing/easy"
//		licensegin "github.com/AnoRebel/licensing/licensing/middleware/gin"
//	)
//
//	r := gin.New()
//	c, _ := easy.NewClient(easy.ClientConfig{ ... })
//	r.Use(licensegin.LicenseMiddleware(licensegin.Config{
//		Client: c,
//		Fingerprint: func(c *gin.Context) (string, error) {
//			return c.GetHeader("X-Fingerprint"), nil
//		},
//	}))
//
//	r.GET("/protected", func(c *gin.Context) {
//		// MustLicense panics if the middleware didn't run; LicenseFrom
//		// returns the handle + ok=false when missing.
//		handle := licensegin.MustLicense(c)
//		c.JSON(200, gin.H{"licenseId": handle.LicenseID})
//	})
//
// Errors are emitted via c.AbortWithStatusJSON; the body shape and
// status-code mapping live in the shared core package.
package gin

import (
	"github.com/gin-gonic/gin"

	"github.com/AnoRebel/licensing/licensing/easy"
	"github.com/AnoRebel/licensing/licensing/middleware"
)

// Config carries the gin-specific configuration for LicenseMiddleware.
type Config struct {
	// Client is a pre-constructed *easy.Client.
	Client *easy.Client
	// Fingerprint extracts the device fingerprint from the *gin.Context.
	// Returning "" or an error short-circuits with 400 MissingFingerprint.
	Fingerprint middleware.FingerprintExtractor[*gin.Context]
	// OnSuccess fires when the guard succeeds. Optional. Errors surface
	// as 500 InternalError.
	OnSuccess middleware.OnSuccessHook[*gin.Context]
}

// licenseGinKey is the gin-context key under which the LicenseHandle is
// stored. Exported as a typed string (not a struct) because gin's
// c.Set / c.Get use string keys; consumers reading via c.Get should
// prefer MustLicense / LicenseFrom over a raw c.Get.
const licenseGinKey = "anorebel.licensing.handle"

// LicenseMiddleware returns a gin-compatible HandlerFunc that runs
// easy.Client.Guard on every request. On success it stores the
// LicenseHandle under licenseGinKey via c.Set and calls c.Next. On
// failure it calls c.AbortWithStatusJSON with the canonical status +
// body and does NOT proceed to downstream handlers.
func LicenseMiddleware(cfg Config) gin.HandlerFunc {
	core := middleware.LicenseGuardConfig{Client: cfg.Client}
	return func(c *gin.Context) {
		result := middleware.RunGuard(c, core, cfg.Fingerprint, cfg.OnSuccess)
		if !result.OK {
			c.AbortWithStatusJSON(result.Status, result.Body)
			return
		}
		c.Set(licenseGinKey, result.Handle)
		c.Next()
	}
}

// MustLicense returns the LicenseHandle attached by LicenseMiddleware.
// Panics with a clear message if the middleware did not run for this
// request — handlers that depend on a license should let the panic
// propagate (it's a routing bug, not a runtime condition).
func MustLicense(c *gin.Context) *easy.LicenseHandle {
	v, ok := c.Get(licenseGinKey)
	if !ok {
		panic("licensing/middleware/gin: license handle missing — did you forget to register LicenseMiddleware?")
	}
	handle, ok := v.(*easy.LicenseHandle)
	if !ok {
		panic("licensing/middleware/gin: licenseGinKey carries unexpected type")
	}
	return handle
}

// LicenseFrom returns the LicenseHandle attached by LicenseMiddleware,
// or (nil, false) if it wasn't run for this request. Useful for
// optional-license routes where the handler wants to branch on
// presence rather than panic.
func LicenseFrom(c *gin.Context) (*easy.LicenseHandle, bool) {
	v, ok := c.Get(licenseGinKey)
	if !ok {
		return nil, false
	}
	handle, ok := v.(*easy.LicenseHandle)
	return handle, ok
}
