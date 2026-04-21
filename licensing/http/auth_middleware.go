package http

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// Principal identifies the actor a bearer token resolves to. Handlers that
// want audit context (e.g. "who performed this rotation") can pull the
// principal out of the request context via PrincipalFromContext.
//
// Fields are all optional; what matters is that a valid Principal was
// returned from the verifier. Subject is the stable identifier and is the
// field the middleware asserts non-empty before letting the request pass.
type Principal struct {
	Meta    map[string]any
	Subject string
	Roles   []string
}

// BearerVerifier resolves a bearer token to a Principal. Implementations are
// responsible for whatever scheme the deployment uses (JWT, opaque token
// lookup, HMAC, etc.). The core does NOT bundle an auth scheme — callers
// wire one in.
//
// Return values:
//   - (non-zero Principal, nil)    → request is authenticated
//   - (zero Principal, ErrUnauth)  → token is invalid; middleware writes 401
//   - (zero Principal, other err)  → unexpected failure; middleware writes 500
type BearerVerifier func(ctx context.Context, token string) (Principal, error)

// ErrInvalidBearer is the canonical error returned by verifiers when a token
// is malformed, expired, or otherwise not acceptable. Verifiers can return
// this directly; the middleware maps it (and anything that errors.Is to it)
// to a 401 response.
var ErrInvalidBearer = errors.New("invalid bearer token")

type principalCtxKey struct{}

// PrincipalFromContext returns the Principal attached by BearerAuth, or the
// zero value if the request is unauthenticated. The bool reports presence so
// handlers can distinguish "no auth middleware ran" from "middleware ran and
// produced an empty subject" (the latter is a misconfiguration).
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalCtxKey{}).(Principal)
	return p, ok
}

// withPrincipal returns a derived context carrying p.
func withPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalCtxKey{}, p)
}

// BearerAuth wraps next with Authorization: Bearer token enforcement. The
// OpenAPI spec marks every admin endpoint with security: [{ bearerAuth: [] }]
// except /health (security: []) — so mount this middleware on the admin
// handler, not on the client handler.
//
// Behaviour:
//   - Missing header                   → 401 Unauthenticated
//   - Header not "Bearer <token>"      → 401 Unauthenticated
//   - verifier returns ErrInvalidBearer→ 401 Unauthenticated
//   - verifier returns other error     → 500 InternalError
//   - verifier returns empty Subject   → 500 InternalError (misconfig)
//   - otherwise                        → next.ServeHTTP with Principal in ctx
//
// Error codes use the stable "Unauthenticated" identifier from the core
// error table (CodeUnauthenticated) so clients can errors.Is() uniformly.
func BearerAuth(verifier BearerVerifier, next http.Handler) http.Handler {
	if verifier == nil {
		panic("http.BearerAuth: verifier is nil")
	}
	if next == nil {
		panic("http.BearerAuth: next is nil")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := extractBearer(r.Header.Get("Authorization"))
		if !ok {
			writeError(w, http.StatusUnauthorized, "Unauthenticated", "missing or malformed bearer token")
			return
		}
		p, err := verifier(r.Context(), token)
		if err != nil {
			if errors.Is(err, ErrInvalidBearer) {
				writeError(w, http.StatusUnauthorized, "Unauthenticated", "invalid bearer token")
				return
			}
			writeError(w, http.StatusInternalServerError, "InternalError", "auth verifier failure")
			return
		}
		if p.Subject == "" {
			writeError(w, http.StatusInternalServerError, "InternalError", "auth verifier returned empty subject")
			return
		}
		next.ServeHTTP(w, r.WithContext(withPrincipal(r.Context(), p)))
	})
}

// extractBearer parses an Authorization header value. The scheme comparison
// is case-insensitive per RFC 7235 §2.1, the token itself is case-sensitive.
// Returns the token and true on success; "", false otherwise.
//
// Tokens are restricted to the RFC 7235 token68 visible-ASCII range
// (0x21..0x7E). This blocks header-injection attempts (CR/LF/NUL) and any
// byte that could disrupt downstream logging or proxy parsing. Verifiers
// that need broader charsets should decode the base64/opaque token
// themselves, after the middleware has fenced off the raw bytes.
func extractBearer(h string) (string, bool) {
	if h == "" {
		return "", false
	}
	// RFC 7235: scheme SP token68. Allow tabs just in case.
	i := strings.IndexAny(h, " \t")
	if i <= 0 {
		return "", false
	}
	if !strings.EqualFold(h[:i], "Bearer") {
		return "", false
	}
	token := strings.TrimLeft(h[i+1:], " \t")
	if token == "" {
		return "", false
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		if c < 0x21 || c > 0x7E {
			return "", false
		}
	}
	return token, true
}

// minStaticTokenLen is the minimum acceptable length for a static bearer
// token. 32 bytes gives ~192 bits of entropy for a base64-random secret,
// well above the NIST SP 800-63B recommendation for bearer secrets. A
// shorter value is almost certainly a handwritten placeholder that should
// never reach a deployed binary.
const minStaticTokenLen = 32

// StaticBearerVerifier returns a verifier that accepts exactly one token and
// maps it to the given Principal. Intended for tests, local development,
// and single-purpose internal services — production admin surfaces should
// plug in a JWT or session-lookup verifier so tokens can be rotated and
// revoked without redeploying.
//
// Requires expected to be at least 32 bytes so a weak or typoed token
// can't slip into production. Uses constant-time comparison to avoid
// timing side channels.
func StaticBearerVerifier(expected string, p Principal) BearerVerifier {
	if expected == "" {
		panic("http.StaticBearerVerifier: expected is empty")
	}
	if len(expected) < minStaticTokenLen {
		panic("http.StaticBearerVerifier: expected must be at least 32 bytes; generate one with `openssl rand -hex 32`")
	}
	if p.Subject == "" {
		panic("http.StaticBearerVerifier: principal.Subject is empty")
	}
	expectedBytes := []byte(expected)
	return func(_ context.Context, token string) (Principal, error) {
		if subtle.ConstantTimeCompare(expectedBytes, []byte(token)) != 1 {
			return Principal{}, ErrInvalidBearer
		}
		return p, nil
	}
}
