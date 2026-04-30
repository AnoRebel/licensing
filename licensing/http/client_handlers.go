package http

import (
	"encoding/json"
	"net/http"
	"time"

	lic "github.com/AnoRebel/licensing/licensing"
)

// ClientHandler is the http.Handler that multiplexes client-facing routes:
//
//	GET  /health
//	POST /activate
//	POST /refresh
//	POST /heartbeat
//	POST /deactivate
//
// Handlers are public (no bearer auth). They authenticate via body contents:
// license key for activate; signed token for refresh/heartbeat/deactivate.
type ClientHandler struct {
	ctx    *ClientContext
	prefix string
}

// NewClientHandler returns an http.Handler mounted at the given prefix
// (typically "/api/licensing/v1"). Unknown paths under the prefix → 404;
// wrong method for a known path → 405.
func NewClientHandler(ctx *ClientContext, prefix string) *ClientHandler {
	return &ClientHandler{ctx: ctx, prefix: prefix}
}

// ServeHTTP dispatches to the matching endpoint.
func (h *ClientHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if h.prefix != "" {
		if len(path) < len(h.prefix) || path[:len(h.prefix)] != h.prefix {
			writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+path)
			return
		}
		path = path[len(h.prefix):]
	}

	switch path {
	case "/health":
		if r.Method != http.MethodGet {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleHealth(w, r)
	case "/activate":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleActivate(w, r)
	case "/refresh":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleRefresh(w, r)
	case "/heartbeat":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleHeartbeat(w, r)
	case "/deactivate":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleDeactivate(w, r)
	default:
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
	}
}

// ---------------- helpers ----------------

func isoOf(unixSec int64) string {
	return time.Unix(unixSec, 0).UTC().Format(time.RFC3339)
}

// verifyClientToken verifies the signature on a client-presented LIC1 token
// against the kid's public key loaded from storage, then enforces nbf/exp
// with an optional past-exp grace.
//
// Ordering mirrors lic.Verify: header shape → kid→alg binding (one-shot, per
// this request) → signature. Only after the signature is valid do we look at
// timing — an attacker's unsigned token never influences the expiry path.
//
// allowExpiredWithin lets /refresh accept a token that expired recently (so a
// legitimately-paused client can still rotate its token) while /heartbeat and
// /deactivate pass 0 and refuse any expired token outright.
//
// This function is the single gatekeeper between "untrusted bytes in the
// request body" and "payload claims we act on" — the caller must never read
// license_id/usage_id from DecodeUnverified.
func verifyClientToken(ctx *ClientContext, token string, allowExpiredWithin time.Duration) (lic.LIC1DecodedParts, error) {
	var zero lic.LIC1DecodedParts

	// Peek at the header to learn which kid signed this. DecodeUnverified
	// only parses structure; trust is established by the Verify call below.
	head, err := lic.DecodeUnverified(token)
	if err != nil {
		return zero, err
	}

	record, err := ctx.Storage.GetKeyByKid(head.Header.Kid)
	if err != nil {
		return zero, err
	}
	if record == nil {
		return zero, lic.NewError(lic.CodeUnknownKid,
			"unknown kid: "+head.Header.Kid,
			map[string]any{"kid": head.Header.Kid})
	}

	// One-shot bindings table: only this (kid, alg) pair is accepted. If the
	// header's alg disagrees with the stored record, Expect returns
	// AlgorithmMismatch before any backend touches the signature — the
	// algorithm-confusion defense we document in docs/security.md.
	bindings := lic.NewKeyAlgBindings()
	if err := bindings.Bind(record.Kid, record.Alg); err != nil {
		return zero, err
	}

	parts, err := lic.Verify(token, lic.VerifyOptions{
		Registry: ctx.Backends,
		Bindings: bindings,
		Keys: map[string]lic.KeyRecord{
			record.Kid: {
				Kid: record.Kid,
				Alg: record.Alg,
				Pem: lic.PemKeyMaterial{PublicPem: record.PublicPem},
			},
		},
	})
	if err != nil {
		return zero, err
	}

	// nbf/exp are written as unix seconds by token_service.go; after JSON
	// decode they come back as float64.
	now, err := time.Parse(time.RFC3339, ctx.Clock.NowISO())
	if err != nil {
		now = time.Now().UTC()
	}
	nowSec := now.Unix()

	if nbf, ok := parts.Payload["nbf"].(float64); ok {
		if nowSec < int64(nbf) {
			return zero, lic.NewError(lic.CodeTokenMalformed,
				"token not yet valid (nbf in future)", nil)
		}
	}
	if exp, ok := parts.Payload["exp"].(float64); ok {
		// Strict `<` matches the interop grace-table fix: a token at exactly
		// exp is already expired. Grace extends the acceptance window past
		// exp by allowExpiredWithin, not before it.
		if nowSec >= int64(exp)+int64(allowExpiredWithin.Seconds()) {
			return zero, lic.NewError(lic.CodeTokenExpired,
				"token is expired", nil)
		}
	}

	return parts, nil
}

// maxRequestBodyBytes caps request-body size to prevent memory-exhaustion
// DoS via giant JSON payloads. LIC1 tokens are well under 4 KiB; the
// largest admin request (key import with encrypted PKCS#8 PEM) still sits
// comfortably under 1 MiB. 1 MiB leaves generous headroom for UTF-8
// expansion and future fields without opening a hole.
const maxRequestBodyBytes int64 = 1 << 20 // 1 MiB

// decodeBody reads the JSON body into out. On failure writes 400 BadRequest
// and returns false; callers should return immediately. The body is capped
// at maxRequestBodyBytes — oversize payloads surface as a decode error and
// get a 400 response.
func decodeBody(w http.ResponseWriter, r *http.Request, out any) bool {
	if r.Body == nil {
		writeError(w, 400, "BadRequest", "request body is required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		writeError(w, 400, "BadRequest", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

// ---------------- /health ----------------

// handleHealth probes storage with a cheap read to verify the issuer is
// actually capable of serving requests (not just listening on the port).
// Returns 200 with `{status, version, time}` on success and 503 with
// `{status: "error", version, time}` when the storage probe fails. The
// probe is intentionally bounded — a `ListAudit` with limit 1 — so it
// catches connection drops and permission issues without paying for a
// full table scan or a write.
//
// The 503 response is still wrapped in the standard success envelope
// (`success: true, data: {status: "error", ...}`) because the high-level
// client uses `/health` as a *liveness* signal, not as a request that can
// itself fail with a typed protocol error. Switching the envelope's
// `success` flag here would force the client to special-case parsing and
// blur the boundary between "issuer is unreachable" and "issuer rejected
// the request".
func (h *ClientHandler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339)
	if h.ctx.Storage == nil {
		writeOKStatus(w, http.StatusServiceUnavailable, map[string]any{
			"status":  "error",
			"version": h.ctx.Version,
			"time":    now,
		})
		return
	}
	if _, err := h.ctx.Storage.ListAudit(lic.AuditLogFilter{}, lic.PageRequest{Limit: 1}); err != nil {
		writeOKStatus(w, http.StatusServiceUnavailable, map[string]any{
			"status":  "error",
			"version": h.ctx.Version,
			"time":    now,
		})
		return
	}
	writeOK(w, map[string]any{
		"status":  "ok",
		"version": h.ctx.Version,
		"time":    now,
	})
}

// ---------------- /activate ----------------

type activateBody struct {
	ClientMeta  map[string]any `json:"client_meta,omitempty"`
	LicenseKey  string         `json:"license_key"`
	Fingerprint string         `json:"fingerprint"`
}

func (h *ClientHandler) handleActivate(w http.ResponseWriter, r *http.Request) {
	var body activateBody
	if !decodeBody(w, r, &body) {
		return
	}
	if body.LicenseKey == "" {
		writeError(w, 400, "BadRequest", "license_key is required")
		return
	}
	if body.Fingerprint == "" {
		writeError(w, 400, "BadRequest", "fingerprint is required")
		return
	}

	license, err := lic.FindLicenseByKey(h.ctx.Storage, body.LicenseKey)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if license == nil {
		writeError(w, 404, "InvalidLicenseKey", "license key is invalid or unknown")
		return
	}

	reg, err := lic.RegisterUsage(h.ctx.Storage, h.ctx.Clock, lic.RegisterUsageInput{
		LicenseID:   license.ID,
		Fingerprint: body.Fingerprint,
		ClientMeta:  body.ClientMeta,
	}, lic.RegisterUsageOptions{Actor: "http:activate"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}

	issued, err := h.issueFor(reg.License, reg.Usage)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}

	resp := map[string]any{
		"token":                  issued.Token,
		"expires_at":             isoOf(issued.Exp),
		"refresh_recommended_at": isoOf(issued.Iat + int64(float64(h.ctx.ttl())*0.75)),
	}
	if foa := extractForceOnlineAfter(issued.Token); foa != nil {
		resp["force_online_after"] = isoOf(*foa)
	}
	writeOK(w, resp)
}

// ---------------- /refresh ----------------

type refreshBody struct {
	Token string `json:"token"`
}

func (h *ClientHandler) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var body refreshBody
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Token == "" {
		writeError(w, 400, "BadRequest", "token is required")
		return
	}

	// /refresh accepts tokens whose exp just passed — a legitimate client
	// paused (sleep/suspend, network partition) should still be able to
	// rotate. The grace is capped at the configured TTL so a long-expired
	// token (days/weeks) can never refresh. Signature + kid binding are
	// still strictly enforced.
	refreshGrace := time.Duration(h.ctx.ttl()) * time.Second
	parts, err := verifyClientToken(h.ctx, body.Token, refreshGrace)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	licenseID, _ := parts.Payload["license_id"].(string)
	usageID, _ := parts.Payload["usage_id"].(string)
	if licenseID == "" || usageID == "" {
		writeError(w, 401, "TokenMalformed", "token missing required claims")
		return
	}

	var (
		license *lic.License
		usage   *lic.LicenseUsage
	)
	txErr := h.ctx.Storage.WithTransaction(func(tx lic.StorageTx) error {
		l, err := tx.GetLicense(licenseID)
		if err != nil {
			return err
		}
		if l == nil {
			return lic.NewError(lic.CodeLicenseNotFound, "license not found: "+licenseID, nil)
		}
		u, err := tx.GetUsage(usageID)
		if err != nil {
			return err
		}
		if u == nil {
			return lic.NewError(lic.CodeLicenseNotFound, "usage not found: "+usageID, nil)
		}
		if u.LicenseID != l.ID {
			return lic.NewError(lic.CodeTokenMalformed, "token usage does not belong to token license", nil)
		}
		if u.Status != lic.UsageStatusActive {
			return lic.NewError(lic.CodeLicenseRevoked, "usage "+u.ID+" is no longer active", nil)
		}
		license = l
		usage = u
		return nil
	})
	if txErr != nil {
		writeErrorFromLicensing(w, txErr)
		return
	}

	issued, err := h.issueFor(license, usage)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}

	resp := map[string]any{
		"token":                  issued.Token,
		"expires_at":             isoOf(issued.Exp),
		"refresh_recommended_at": isoOf(issued.Iat + int64(float64(h.ctx.ttl())*0.75)),
	}
	if foa := extractForceOnlineAfter(issued.Token); foa != nil {
		resp["force_online_after"] = isoOf(*foa)
	}
	writeOK(w, resp)
}

// ---------------- /heartbeat ----------------

type heartbeatBody struct {
	Token string `json:"token"`
}

func (h *ClientHandler) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var body heartbeatBody
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Token == "" {
		writeError(w, 400, "BadRequest", "token is required")
		return
	}

	// /heartbeat: strict verification, no expiry grace. An expired token
	// cannot keep a seat warm.
	parts, err := verifyClientToken(h.ctx, body.Token, 0)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	licenseID, _ := parts.Payload["license_id"].(string)
	usageID, _ := parts.Payload["usage_id"].(string)
	if licenseID == "" || usageID == "" {
		writeError(w, 401, "TokenMalformed", "token missing required claims")
		return
	}

	txErr := h.ctx.Storage.WithTransaction(func(tx lic.StorageTx) error {
		l, err := tx.GetLicense(licenseID)
		if err != nil {
			return err
		}
		if l == nil {
			return lic.NewError(lic.CodeLicenseNotFound, "license not found: "+licenseID, nil)
		}
		if l.Status == lic.LicenseStatusRevoked {
			return lic.NewError(lic.CodeLicenseRevoked, "license is revoked", nil)
		}
		if l.Status == lic.LicenseStatusSuspended {
			return lic.NewError(lic.CodeLicenseSuspended, "license is suspended", nil)
		}
		u, err := tx.GetUsage(usageID)
		if err != nil {
			return err
		}
		if u == nil || u.Status != lic.UsageStatusActive {
			return lic.NewError(lic.CodeLicenseRevoked, "usage "+usageID+" is no longer active", nil)
		}
		return nil
	})
	if txErr != nil {
		writeErrorFromLicensing(w, txErr)
		return
	}

	writeOK(w, map[string]any{
		"ok":          true,
		"server_time": h.ctx.Clock.NowISO(),
	})
}

// ---------------- /deactivate ----------------

type deactivateBody struct {
	Token  string `json:"token"`
	Reason string `json:"reason"`
}

var allowedDeactivateReasons = map[string]bool{
	"user_requested": true,
	"uninstall":      true,
	"reassign":       true,
	"other":          true,
}

func (h *ClientHandler) handleDeactivate(w http.ResponseWriter, r *http.Request) {
	var body deactivateBody
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Token == "" {
		writeError(w, 400, "BadRequest", "token is required")
		return
	}
	if !allowedDeactivateReasons[body.Reason] {
		writeError(w, 400, "BadRequest", "invalid reason: "+body.Reason)
		return
	}

	// /deactivate: strict verification. An attacker who learns a usage_id
	// must not be able to free someone else's seat by submitting an
	// unsigned or wrong-key token.
	parts, err := verifyClientToken(h.ctx, body.Token, 0)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	usageID, _ := parts.Payload["usage_id"].(string)
	if usageID == "" {
		writeError(w, 401, "TokenMalformed", "token missing usage_id")
		return
	}

	usage, err := h.ctx.Storage.GetUsage(usageID)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if usage == nil {
		writeError(w, 404, "NotFound", "usage not found: "+usageID)
		return
	}
	if usage.Status != lic.UsageStatusRevoked {
		if _, err := lic.RevokeUsage(h.ctx.Storage, h.ctx.Clock, usageID, lic.RevokeUsageOptions{
			Actor: "client:" + body.Reason,
		}); err != nil {
			writeErrorFromLicensing(w, err)
			return
		}
	}
	writeNoContent(w)
}

// ---------------- helpers ----------------

func (h *ClientHandler) issueFor(license *lic.License, usage *lic.LicenseUsage) (*lic.IssueTokenResult, error) {
	input := lic.IssueTokenInput{
		License:           license,
		Usage:             usage,
		TTLSeconds:        h.ctx.ttl(),
		Alg:               h.ctx.alg(),
		SigningPassphrase: h.ctx.SigningPassphrase,
	}
	if h.ctx.ForceOnlineAfter != nil {
		v := *h.ctx.ForceOnlineAfter
		input.ForceOnlineAfter = lic.OptIntOverride{Set: true, Value: &v}
	}
	return lic.IssueToken(h.ctx.Storage, h.ctx.Clock, h.ctx.Backends, input)
}

// extractForceOnlineAfter peeks at a freshly-issued token and returns its
// force_online_after claim if present. Nil if absent or malformed.
func extractForceOnlineAfter(token string) *int64 {
	parts, err := lic.DecodeUnverified(token)
	if err != nil {
		return nil
	}
	v, ok := parts.Payload["force_online_after"]
	if !ok {
		return nil
	}
	switch x := v.(type) {
	case float64:
		i := int64(x)
		return &i
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return &i
		}
	case int64:
		return &x
	}
	return nil
}
