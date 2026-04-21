// Package http provides framework-agnostic HTTP handlers for the licensing
// issuer client and admin endpoints.
//
// Mirrors @licensing/http-handlers on the TypeScript side. Handlers implement
// the stdlib net/http.Handler interface, so they compose cleanly with every
// Go web framework in common use. Response envelopes and status codes are
// contract-conformant with openapi/licensing-admin.yaml.
//
// # Components
//
//   - ClientHandler — client-facing endpoints (/health, /activate, /refresh,
//     /heartbeat, /deactivate). Constructed from a ClientContext.
//   - AdminHandler — admin endpoints under /admin/... (licenses, scopes,
//     templates, usages, keys, audit). Constructed from an AdminContext.
//   - BearerAuth  — pluggable bearer-token middleware. The core does not
//     bundle an auth scheme; callers wire a BearerVerifier (JWT, opaque
//     token lookup, HMAC, etc.). StaticBearerVerifier is provided for
//     tests and single-token deployments.
//   - RateLimiter — token-bucket limiter with 429 + Retry-After. Per-IP
//     bucketing by default (X-Forwarded-For / X-Real-IP / RemoteAddr);
//     swap KeyFunc for per-user or per-tenant limiting.
//
// # Stdlib mount (no framework)
//
//	client := http.NewClientHandler(clientCtx)
//	admin  := http.NewAdminHandler(adminCtx)
//
//	mux := nethttp.NewServeMux()
//	mux.Handle("/health",     client)
//	mux.Handle("/activate",   client)
//	mux.Handle("/refresh",    client)
//	mux.Handle("/heartbeat",  client)
//	mux.Handle("/deactivate", client)
//
//	// Admin surface: bearer auth + rate limit in front of the handler.
//	// NOTE: StaticBearerVerifier is intended for tests and local dev. In
//	// production, wire a JWT/session-lookup BearerVerifier so tokens can be
//	// rotated and revoked without redeploying. The static verifier rejects
//	// any token shorter than 32 bytes to keep handwritten placeholders out
//	// of deployed binaries.
//	rl := http.NewRateLimiter(http.RateLimitConfig{Capacity: 60, RefillRate: 20})
//	verifier := http.StaticBearerVerifier(os.Getenv("ADMIN_TOKEN"),
//	    http.Principal{Subject: "admin:ops"})
//	mux.Handle("/admin/", rl.Middleware(http.BearerAuth(verifier, admin)))
//
//	nethttp.ListenAndServe(":8080", mux)
//
// # Rate limiter keying behind a proxy
//
// The default KeyFunc (RemoteAddrKeyFunc) reads r.RemoteAddr only, so any
// client can't forge its bucket via X-Forwarded-For. If the issuer sits
// behind a known reverse proxy, switch to TrustedProxyKeyFunc so the real
// client IP is used — but only when the direct peer matches the trusted
// prefix set:
//
//	trusted := []netip.Prefix{
//	    netip.MustParsePrefix("10.0.0.0/8"),     // internal LB
//	    netip.MustParsePrefix("::1/128"),        // local dev
//	}
//	rl := http.NewRateLimiter(http.RateLimitConfig{
//	    Capacity:   60,
//	    RefillRate: 20,
//	    KeyFunc:    http.TrustedProxyKeyFunc(trusted),
//	})
//
// # Framework bridges
//
// http.Handler is Go's universal interop point, so every major framework
// can mount these handlers in one line. Examples below assume `adminH` is
// an already-wrapped handler (auth + rate limit + admin).
//
// chi (chi.Router embeds http.Handler — no bridge needed):
//
//	r := chi.NewRouter()
//	r.Mount("/admin", adminH)
//	r.Mount("/", clientH)
//
// gorilla/mux (same — native http.Handler):
//
//	r := mux.NewRouter()
//	r.PathPrefix("/admin").Handler(adminH)
//	r.PathPrefix("/").Handler(clientH)
//
// Echo (wrap with echo.WrapHandler):
//
//	e := echo.New()
//	e.Any("/admin/*", echo.WrapHandler(adminH))
//	e.Any("/health", echo.WrapHandler(clientH))
//	e.Any("/activate", echo.WrapHandler(clientH))
//	// ...repeat for /refresh, /heartbeat, /deactivate
//
// Gin (wrap with gin.WrapH):
//
//	r := gin.Default()
//	r.Any("/admin/*any", gin.WrapH(adminH))
//	r.Any("/health", gin.WrapH(clientH))
//	r.Any("/activate", gin.WrapH(clientH))
//
// Fiber v2 (via adaptor package):
//
//	app := fiber.New()
//	app.Use("/admin", adaptor.HTTPHandler(adminH))
//	app.All("/health", adaptor.HTTPHandler(clientH))
//
// # Custom auth
//
// Implement BearerVerifier to integrate with whatever identity system the
// deployment uses. Return ErrInvalidBearer for unauthenticated requests
// (the middleware maps it to 401); return any other error for operational
// failures (500).
//
//	verifier := func(ctx context.Context, token string) (http.Principal, error) {
//	    claims, err := jwt.Verify(token, publicKey)
//	    if err != nil {
//	        return http.Principal{}, http.ErrInvalidBearer
//	    }
//	    return http.Principal{
//	        Subject: claims.Subject,
//	        Roles:   claims.Roles,
//	    }, nil
//	}
//
// Handlers reach the Principal via http.PrincipalFromContext(r.Context()).
//
// # Custom rate-limit keys
//
// Bucket by user ID instead of IP:
//
//	rl := http.NewRateLimiter(http.RateLimitConfig{
//	    Capacity:   60,
//	    RefillRate: 20,
//	    KeyFunc: func(r *nethttp.Request) string {
//	        if p, ok := http.PrincipalFromContext(r.Context()); ok {
//	            return "user:" + p.Subject
//	        }
//	        return r.RemoteAddr
//	    },
//	})
//
// Order matters: mount BearerAuth *before* RateLimiter if you want the
// limiter to see the resolved Principal.
package http
