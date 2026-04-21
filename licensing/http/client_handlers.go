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

// decodeBody reads the JSON body into out. On failure writes 400 BadRequest
// and returns false; callers should return immediately.
func decodeBody(w http.ResponseWriter, r *http.Request, out any) bool {
	if r.Body == nil {
		writeError(w, 400, "BadRequest", "request body is required")
		return false
	}
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

func (h *ClientHandler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeOK(w, map[string]any{
		"status":  "ok",
		"version": h.ctx.Version,
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

	parts, err := lic.DecodeUnverified(body.Token)
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

	parts, err := lic.DecodeUnverified(body.Token)
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

	parts, err := lic.DecodeUnverified(body.Token)
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
