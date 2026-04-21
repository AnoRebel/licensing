package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	lic "github.com/AnoRebel/licensing/licensing"
)

// AdminHandler multiplexes the 16 admin-facing routes per
// openapi/licensing-admin.yaml:
//
//	Licenses:  GET/POST  /admin/licenses,        GET/PATCH/DELETE /admin/licenses/{id}
//	           POST /admin/licenses/{id}/{suspend,resume,revoke,renew}
//	Scopes:    GET/POST  /admin/scopes,          GET/PATCH/DELETE /admin/scopes/{id}
//	Templates: GET/POST  /admin/templates,       GET/PATCH/DELETE /admin/templates/{id}
//	Usages:    GET       /admin/usages,          GET              /admin/usages/{id}
//	           POST      /admin/usages/{id}/revoke
//	Keys:      GET/POST  /admin/keys,            POST             /admin/keys/{id}/rotate
//	Audit:     GET       /admin/audit
//
// All routes are authenticated elsewhere — this handler assumes the request
// has already passed through bearer auth middleware.
type AdminHandler struct {
	ctx    *AdminContext
	prefix string
}

// NewAdminHandler returns an http.Handler mounted at prefix (typically
// "/api/licensing/v1"). Unknown paths → 404; wrong method → 405.
func NewAdminHandler(ctx *AdminContext, prefix string) *AdminHandler {
	return &AdminHandler{ctx: ctx, prefix: prefix}
}

func (h *AdminHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if h.prefix != "" {
		if !strings.HasPrefix(path, h.prefix) {
			writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+path)
			return
		}
		path = path[len(h.prefix):]
	}
	if !strings.HasPrefix(path, "/admin/") {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	segs := strings.Split(strings.TrimPrefix(path, "/admin/"), "/")
	// segs[0] is the resource ("licenses", "scopes", ...); subsequent
	// segments are id + sub-action.
	switch segs[0] {
	case "licenses":
		h.routeLicenses(w, r, segs[1:])
	case "scopes":
		h.routeScopes(w, r, segs[1:])
	case "templates":
		h.routeTemplates(w, r, segs[1:])
	case "usages":
		h.routeUsages(w, r, segs[1:])
	case "keys":
		h.routeKeys(w, r, segs[1:])
	case "audit":
		h.routeAudit(w, r, segs[1:])
	default:
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
	}
}

// ---------------- shared helpers ----------------

// pageCursor is the wire shape for the `data` portion of a list envelope.
// openapi: `{ items: [...], next_cursor: <string|null> }`.
type pageEnvelope struct {
	NextCursor string `json:"next_cursor"`
	Items      []any  `json:"items"`
}

func writePage[T any](w http.ResponseWriter, p lic.Page[T]) {
	items := make([]any, len(p.Items))
	for i := range p.Items {
		items[i] = p.Items[i]
	}
	writeOK(w, pageEnvelope{Items: items, NextCursor: p.Cursor})
}

func parsePageRequest(r *http.Request) (lic.PageRequest, error) {
	q := r.URL.Query()
	limit := 50
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 || v > 500 {
			return lic.PageRequest{}, errors.New("limit must be an integer in [1, 500]")
		}
		limit = v
	}
	return lic.PageRequest{Limit: limit, Cursor: q.Get("cursor")}, nil
}

func stringQuery(r *http.Request, key string) *string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return nil
	}
	return &v
}

// keyToWire strips `private_pem_enc` — the encrypted private key must
// never leak through the admin surface.
func keyToWire(k *lic.LicenseKey) map[string]any {
	return map[string]any{
		"id":           k.ID,
		"scope_id":     k.ScopeID,
		"kid":          k.Kid,
		"alg":          k.Alg,
		"role":         k.Role,
		"state":        k.State,
		"public_pem":   k.PublicPem,
		"rotated_from": k.RotatedFrom,
		"rotated_at":   k.RotatedAt,
		"not_before":   k.NotBefore,
		"not_after":    k.NotAfter,
		"meta":         k.Meta,
		"created_at":   k.CreatedAt,
		"updated_at":   k.UpdatedAt,
	}
}

// parseIDAndAction matches `[id]` or `[id sub-action]` or `[]`.
func parseIDAndAction(segs []string) (id, action string, ok bool) {
	switch len(segs) {
	case 0:
		return "", "", true
	case 1:
		if segs[0] == "" {
			return "", "", true
		}
		return segs[0], "", true
	case 2:
		if segs[0] == "" || segs[1] == "" {
			return "", "", false
		}
		return segs[0], segs[1], true
	default:
		return "", "", false
	}
}

// ---------------- Licenses ----------------

func (h *AdminHandler) routeLicenses(w http.ResponseWriter, r *http.Request, segs []string) {
	id, action, ok := parseIDAndAction(segs)
	if !ok {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	switch {
	case id == "":
		switch r.Method {
		case http.MethodGet:
			h.handleListLicenses(w, r)
		case http.MethodPost:
			h.handleCreateLicense(w, r)
		default:
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		}
	case action == "":
		switch r.Method {
		case http.MethodGet:
			h.handleGetLicense(w, r, id)
		case http.MethodPatch:
			h.handleUpdateLicense(w, r, id)
		case http.MethodDelete:
			h.handleDeleteLicense(w, r, id)
		default:
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		}
	default:
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		switch action {
		case "suspend":
			h.handleLifecycle(w, r, id, lic.Suspend, "suspend")
		case "resume":
			h.handleLifecycle(w, r, id, lic.Resume, "resume")
		case "revoke":
			h.handleLifecycle(w, r, id, lic.Revoke, "revoke")
		case "renew":
			h.handleRenewLicense(w, r, id)
		default:
			writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		}
	}
}

func (h *AdminHandler) handleListLicenses(w http.ResponseWriter, r *http.Request) {
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	filter := lic.LicenseFilter{}
	q := r.URL.Query()
	if v := q.Get("scope_id"); v != "" {
		filter.ScopeID = &v
		filter.ScopeIDSet = true
	}
	if v := q.Get("template_id"); v != "" {
		filter.TemplateID = &v
		filter.TemplateIDSet = true
	}
	if v := q.Get("status"); v != "" {
		filter.Status = []lic.LicenseStatus{lic.LicenseStatus(v)}
	}
	if v := q.Get("licensable"); v != "" {
		idx := strings.IndexByte(v, ':')
		if idx > 0 && idx < len(v)-1 {
			t, id := v[:idx], v[idx+1:]
			filter.LicensableType = &t
			filter.LicensableID = &id
		}
	}
	p, err := h.ctx.Storage.ListLicenses(filter, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writePage(w, p)
}

type createLicenseBody struct {
	ScopeID        *string        `json:"scope_id,omitempty"`
	TemplateID     *string        `json:"template_id,omitempty"`
	LicenseKey     *string        `json:"license_key,omitempty"`
	ExpiresAt      *string        `json:"expires_at,omitempty"`
	GraceUntil     *string        `json:"grace_until,omitempty"`
	Meta           map[string]any `json:"meta,omitempty"`
	LicensableType string         `json:"licensable_type"`
	LicensableID   string         `json:"licensable_id"`
	MaxUsages      int            `json:"max_usages"`
}

func (h *AdminHandler) handleCreateLicense(w http.ResponseWriter, r *http.Request) {
	var b createLicenseBody
	if !decodeBody(w, r, &b) {
		return
	}
	if b.LicensableType == "" || b.LicensableID == "" {
		writeError(w, 400, "BadRequest", "licensable_type and licensable_id are required")
		return
	}
	if b.MaxUsages < 1 {
		writeError(w, 400, "BadRequest", "max_usages must be >= 1")
		return
	}
	var templateID string
	if b.TemplateID != nil {
		templateID = *b.TemplateID
	}
	input := lic.CreateLicenseInput{
		ScopeID:        b.ScopeID,
		LicensableType: b.LicensableType,
		LicensableID:   b.LicensableID,
		MaxUsages:      b.MaxUsages,
		ExpiresAt:      b.ExpiresAt,
		GraceUntil:     b.GraceUntil,
		Meta:           b.Meta,
	}
	if b.LicenseKey != nil {
		input.LicenseKey = *b.LicenseKey
	}
	// If template_id is present, use CreateLicenseFromTemplate for default
	// propagation (max_usages, trial window, grace window, entitlements).
	if templateID != "" {
		fromT := lic.CreateLicenseFromTemplateInput{
			TemplateID:     templateID,
			LicensableType: b.LicensableType,
			LicensableID:   b.LicensableID,
			Meta:           b.Meta,
		}
		if b.ScopeID != nil {
			fromT.ScopeID = lic.OptStringOverride{Set: true, Value: b.ScopeID}
		}
		if b.MaxUsages > 0 {
			fromT.MaxUsages = &b.MaxUsages
		}
		if b.ExpiresAt != nil {
			fromT.ExpiresAt = lic.OptStringOverride{Set: true, Value: b.ExpiresAt}
		}
		if b.GraceUntil != nil {
			fromT.GraceUntil = lic.OptStringOverride{Set: true, Value: b.GraceUntil}
		}
		if b.LicenseKey != nil {
			fromT.LicenseKey = *b.LicenseKey
		}
		l, err := lic.CreateLicenseFromTemplate(h.ctx.Storage, h.ctx.Clock, fromT, lic.CreateLicenseOptions{Actor: "admin"})
		if err != nil {
			writeErrorFromLicensing(w, err)
			return
		}
		writeOKStatus(w, http.StatusCreated, l)
		return
	}
	l, err := lic.CreateLicense(h.ctx.Storage, h.ctx.Clock, input, lic.CreateLicenseOptions{Actor: "admin"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOKStatus(w, http.StatusCreated, l)
}

func (h *AdminHandler) handleGetLicense(w http.ResponseWriter, _ *http.Request, id string) {
	l, err := h.ctx.Storage.GetLicense(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if l == nil {
		writeError(w, 404, "NotFound", "license not found: "+id)
		return
	}
	writeOK(w, l)
}

type updateLicenseBody struct {
	MaxUsages  *int            `json:"max_usages,omitempty"`
	Meta       map[string]any  `json:"meta,omitempty"`
	ExpiresAt  json.RawMessage `json:"expires_at,omitempty"`
	GraceUntil json.RawMessage `json:"grace_until,omitempty"`
}

func (h *AdminHandler) handleUpdateLicense(w http.ResponseWriter, r *http.Request, id string) {
	var b updateLicenseBody
	if !decodeBody(w, r, &b) {
		return
	}
	patch := lic.LicensePatch{MaxUsages: b.MaxUsages}
	if opt, ok := decodeOptString(b.ExpiresAt); ok {
		patch.ExpiresAt = opt
	}
	if opt, ok := decodeOptString(b.GraceUntil); ok {
		patch.GraceUntil = opt
	}
	if b.Meta != nil {
		patch.Meta = lic.OptJSON{Set: true, Value: b.Meta}
	}
	l, err := h.ctx.Storage.UpdateLicense(id, patch)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOK(w, l)
}

func (h *AdminHandler) handleDeleteLicense(w http.ResponseWriter, _ *http.Request, id string) {
	if err := h.ctx.Storage.DeleteLicense(id); err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeNoContent(w)
}

// handleLifecycle is shared by /suspend /resume /revoke — each delegates to
// the named lifecycle function inside a single transaction.
func (h *AdminHandler) handleLifecycle(
	w http.ResponseWriter, _ *http.Request, id string,
	fn func(lic.StorageTx, *lic.License, lic.Clock, lic.TransitionOptions) (*lic.License, error),
	action string,
) {
	var updated *lic.License
	txErr := h.ctx.Storage.WithTransaction(func(tx lic.StorageTx) error {
		l, err := tx.GetLicense(id)
		if err != nil {
			return err
		}
		if l == nil {
			return lic.NewError(lic.CodeLicenseNotFound, "license not found: "+id, map[string]any{"id": id})
		}
		updated, err = fn(tx, l, h.ctx.Clock, lic.TransitionOptions{Actor: "admin:" + action})
		return err
	})
	if txErr != nil {
		writeErrorFromLicensing(w, txErr)
		return
	}
	writeOK(w, updated)
}

type renewLicenseBody struct {
	ExpiresAt  *string         `json:"expires_at"`
	GraceUntil json.RawMessage `json:"grace_until,omitempty"`
}

func (h *AdminHandler) handleRenewLicense(w http.ResponseWriter, r *http.Request, id string) {
	var b renewLicenseBody
	if !decodeBody(w, r, &b) {
		return
	}
	if b.ExpiresAt == nil || *b.ExpiresAt == "" {
		writeError(w, 400, "BadRequest", "expires_at is required")
		return
	}
	opts := lic.RenewOptions{
		TransitionOptions: lic.TransitionOptions{Actor: "admin:renew"},
		ExpiresAt:         b.ExpiresAt,
	}
	if opt, ok := decodeOptString(b.GraceUntil); ok {
		opts.GraceUntil = opt.Value
		opts.GraceUntilSet = true
	}
	var updated *lic.License
	txErr := h.ctx.Storage.WithTransaction(func(tx lic.StorageTx) error {
		l, err := tx.GetLicense(id)
		if err != nil {
			return err
		}
		if l == nil {
			return lic.NewError(lic.CodeLicenseNotFound, "license not found: "+id, map[string]any{"id": id})
		}
		updated, err = lic.Renew(tx, l, h.ctx.Clock, opts)
		return err
	})
	if txErr != nil {
		writeErrorFromLicensing(w, txErr)
		return
	}
	writeOK(w, updated)
}

// ---------------- Scopes ----------------

func (h *AdminHandler) routeScopes(w http.ResponseWriter, r *http.Request, segs []string) {
	id, action, ok := parseIDAndAction(segs)
	if !ok || action != "" {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	if id == "" {
		switch r.Method {
		case http.MethodGet:
			h.handleListScopes(w, r)
		case http.MethodPost:
			h.handleCreateScope(w, r)
		default:
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		}
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.handleGetScope(w, r, id)
	case http.MethodPatch:
		h.handleUpdateScope(w, r, id)
	case http.MethodDelete:
		h.handleDeleteScope(w, r, id)
	default:
		writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
	}
}

func (h *AdminHandler) handleListScopes(w http.ResponseWriter, r *http.Request) {
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	p, err := h.ctx.Storage.ListScopes(lic.LicenseScopeFilter{}, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writePage(w, p)
}

type createScopeBody struct {
	Meta map[string]any `json:"meta,omitempty"`
	Slug string         `json:"slug"`
	Name string         `json:"name"`
}

func (h *AdminHandler) handleCreateScope(w http.ResponseWriter, r *http.Request) {
	var b createScopeBody
	if !decodeBody(w, r, &b) {
		return
	}
	if b.Slug == "" || b.Name == "" {
		writeError(w, 400, "BadRequest", "slug and name are required")
		return
	}
	sc, err := lic.CreateScope(h.ctx.Storage, h.ctx.Clock, lic.CreateScopeInput{
		Slug: b.Slug, Name: b.Name, Meta: b.Meta,
	}, lic.CreateScopeOptions{Actor: "admin"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOKStatus(w, http.StatusCreated, sc)
}

func (h *AdminHandler) handleGetScope(w http.ResponseWriter, _ *http.Request, id string) {
	sc, err := h.ctx.Storage.GetScope(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if sc == nil {
		writeError(w, 404, "NotFound", "scope not found: "+id)
		return
	}
	writeOK(w, sc)
}

type updateScopeBody struct {
	Name *string        `json:"name,omitempty"`
	Meta map[string]any `json:"meta,omitempty"`
}

func (h *AdminHandler) handleUpdateScope(w http.ResponseWriter, r *http.Request, id string) {
	var b updateScopeBody
	if !decodeBody(w, r, &b) {
		return
	}
	patch := lic.LicenseScopePatch{Name: b.Name}
	if b.Meta != nil {
		patch.Meta = lic.OptJSON{Set: true, Value: b.Meta}
	}
	sc, err := h.ctx.Storage.UpdateScope(id, patch)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOK(w, sc)
}

func (h *AdminHandler) handleDeleteScope(w http.ResponseWriter, _ *http.Request, id string) {
	if err := h.ctx.Storage.DeleteScope(id); err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeNoContent(w)
}

// ---------------- Templates ----------------

func (h *AdminHandler) routeTemplates(w http.ResponseWriter, r *http.Request, segs []string) {
	id, action, ok := parseIDAndAction(segs)
	if !ok || action != "" {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	if id == "" {
		switch r.Method {
		case http.MethodGet:
			h.handleListTemplates(w, r)
		case http.MethodPost:
			h.handleCreateTemplate(w, r)
		default:
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		}
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.handleGetTemplate(w, r, id)
	case http.MethodPatch:
		h.handleUpdateTemplate(w, r, id)
	case http.MethodDelete:
		h.handleDeleteTemplate(w, r, id)
	default:
		writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
	}
}

func (h *AdminHandler) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	filter := lic.LicenseTemplateFilter{}
	if v := stringQuery(r, "scope_id"); v != nil {
		filter.ScopeID = v
		filter.ScopeIDSet = true
	}
	p, err := h.ctx.Storage.ListTemplates(filter, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writePage(w, p)
}

type createTemplateBody struct {
	ScopeID             *string        `json:"scope_id,omitempty"`
	ForceOnlineAfterSec *int           `json:"force_online_after_sec,omitempty"`
	Entitlements        map[string]any `json:"entitlements,omitempty"`
	Meta                map[string]any `json:"meta,omitempty"`
	Name                string         `json:"name"`
	MaxUsages           int            `json:"max_usages"`
	TrialDurationSec    int            `json:"trial_duration_sec"`
	GraceDurationSec    int            `json:"grace_duration_sec"`
}

func (h *AdminHandler) handleCreateTemplate(w http.ResponseWriter, r *http.Request) {
	var b createTemplateBody
	if !decodeBody(w, r, &b) {
		return
	}
	if b.Name == "" {
		writeError(w, 400, "BadRequest", "name is required")
		return
	}
	if b.MaxUsages < 1 {
		writeError(w, 400, "BadRequest", "max_usages must be >= 1")
		return
	}
	tmpl, err := lic.CreateTemplate(h.ctx.Storage, h.ctx.Clock, lic.CreateTemplateInput{
		ScopeID:             b.ScopeID,
		Name:                b.Name,
		MaxUsages:           b.MaxUsages,
		TrialDurationSec:    b.TrialDurationSec,
		GraceDurationSec:    b.GraceDurationSec,
		ForceOnlineAfterSec: b.ForceOnlineAfterSec,
		Entitlements:        b.Entitlements,
		Meta:                b.Meta,
	}, lic.CreateTemplateOptions{Actor: "admin"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOKStatus(w, http.StatusCreated, tmpl)
}

func (h *AdminHandler) handleGetTemplate(w http.ResponseWriter, _ *http.Request, id string) {
	tmpl, err := h.ctx.Storage.GetTemplate(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if tmpl == nil {
		writeError(w, 404, "NotFound", "template not found: "+id)
		return
	}
	writeOK(w, tmpl)
}

type updateTemplateBody struct {
	Name                *string         `json:"name,omitempty"`
	MaxUsages           *int            `json:"max_usages,omitempty"`
	TrialDurationSec    *int            `json:"trial_duration_sec,omitempty"`
	GraceDurationSec    *int            `json:"grace_duration_sec,omitempty"`
	Entitlements        map[string]any  `json:"entitlements,omitempty"`
	Meta                map[string]any  `json:"meta,omitempty"`
	ForceOnlineAfterSec json.RawMessage `json:"force_online_after_sec,omitempty"`
}

func (h *AdminHandler) handleUpdateTemplate(w http.ResponseWriter, r *http.Request, id string) {
	var b updateTemplateBody
	if !decodeBody(w, r, &b) {
		return
	}
	patch := lic.LicenseTemplatePatch{
		Name:             b.Name,
		MaxUsages:        b.MaxUsages,
		TrialDurationSec: b.TrialDurationSec,
		GraceDurationSec: b.GraceDurationSec,
	}
	if opt, ok := decodeOptInt(b.ForceOnlineAfterSec); ok {
		patch.ForceOnlineAfterSec = opt
	}
	if b.Entitlements != nil {
		patch.Entitlements = lic.OptJSON{Set: true, Value: b.Entitlements}
	}
	if b.Meta != nil {
		patch.Meta = lic.OptJSON{Set: true, Value: b.Meta}
	}
	tmpl, err := h.ctx.Storage.UpdateTemplate(id, patch)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOK(w, tmpl)
}

func (h *AdminHandler) handleDeleteTemplate(w http.ResponseWriter, _ *http.Request, id string) {
	if err := h.ctx.Storage.DeleteTemplate(id); err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeNoContent(w)
}

// ---------------- Usages ----------------

func (h *AdminHandler) routeUsages(w http.ResponseWriter, r *http.Request, segs []string) {
	id, action, ok := parseIDAndAction(segs)
	if !ok {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	switch {
	case id == "":
		if r.Method != http.MethodGet {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleListUsages(w, r)
	case action == "":
		if r.Method != http.MethodGet {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleGetUsage(w, r, id)
	case action == "revoke":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleRevokeUsage(w, r, id)
	default:
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
	}
}

func (h *AdminHandler) handleListUsages(w http.ResponseWriter, r *http.Request) {
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	filter := lic.LicenseUsageFilter{}
	if v := stringQuery(r, "license_id"); v != nil {
		filter.LicenseID = v
	}
	if v := r.URL.Query().Get("status"); v != "" {
		filter.Status = []lic.UsageStatus{lic.UsageStatus(v)}
	}
	p, err := h.ctx.Storage.ListUsages(filter, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writePage(w, p)
}

func (h *AdminHandler) handleGetUsage(w http.ResponseWriter, _ *http.Request, id string) {
	u, err := h.ctx.Storage.GetUsage(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if u == nil {
		writeError(w, 404, "NotFound", "usage not found: "+id)
		return
	}
	writeOK(w, u)
}

func (h *AdminHandler) handleRevokeUsage(w http.ResponseWriter, _ *http.Request, id string) {
	// RevokeUsage is a no-op on an already-revoked usage.
	u, err := h.ctx.Storage.GetUsage(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if u == nil {
		writeError(w, 404, "NotFound", "usage not found: "+id)
		return
	}
	revoked, err := lic.RevokeUsage(h.ctx.Storage, h.ctx.Clock, id, lic.RevokeUsageOptions{Actor: "admin:revoke"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOK(w, revoked)
}

// ---------------- Keys ----------------

func (h *AdminHandler) routeKeys(w http.ResponseWriter, r *http.Request, segs []string) {
	id, action, ok := parseIDAndAction(segs)
	if !ok {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	switch {
	case id == "":
		switch r.Method {
		case http.MethodGet:
			h.handleListKeys(w, r)
		case http.MethodPost:
			h.handleCreateKey(w, r)
		default:
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		}
	case action == "rotate":
		if r.Method != http.MethodPost {
			writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
			return
		}
		h.handleRotateKey(w, r, id)
	default:
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
	}
}

func (h *AdminHandler) handleListKeys(w http.ResponseWriter, r *http.Request) {
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	filter := lic.LicenseKeyFilter{}
	if v := stringQuery(r, "scope_id"); v != nil {
		filter.ScopeID = v
		filter.ScopeIDSet = true
	}
	if v := r.URL.Query().Get("state"); v != "" {
		ks := lic.KeyState(v)
		filter.State = &ks
	}
	p, err := h.ctx.Storage.ListKeys(filter, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	// Strip private_pem_enc from every item.
	items := make([]any, len(p.Items))
	for i := range p.Items {
		items[i] = keyToWire(&p.Items[i])
	}
	writeOK(w, pageEnvelope{Items: items, NextCursor: p.Cursor})
}

type createKeyBody struct {
	ScopeID   *string        `json:"scope_id,omitempty"`
	NotBefore *string        `json:"not_before,omitempty"`
	NotAfter  *string        `json:"not_after,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
	Kid       string         `json:"kid"`
	Alg       string         `json:"alg"`
	Role      string         `json:"role"`
}

func (h *AdminHandler) handleCreateKey(w http.ResponseWriter, r *http.Request) {
	var b createKeyBody
	if !decodeBody(w, r, &b) {
		return
	}
	if b.Kid == "" {
		writeError(w, 400, "BadRequest", "kid is required")
		return
	}
	if b.Alg == "" {
		writeError(w, 400, "BadRequest", "alg is required")
		return
	}
	if b.Role != "root" && b.Role != "signing" {
		writeError(w, 400, "BadRequest", "role must be 'root' or 'signing'")
		return
	}
	if h.ctx.RootPassphrase == "" {
		writeError(w, 400, "BadRequest", "root passphrase is not configured on this issuer")
		return
	}
	if b.Role == "signing" && h.ctx.SigningPassphrase == "" {
		writeError(w, 400, "BadRequest", "signing passphrase is not configured on this issuer")
		return
	}
	alg := lic.KeyAlg(b.Alg)

	if b.Role == "root" {
		key, err := lic.GenerateRootKey(h.ctx.Storage, h.ctx.Clock, h.ctx.Backends, lic.GenerateRootKeyInput{
			ScopeID:    b.ScopeID,
			Alg:        alg,
			Passphrase: h.ctx.RootPassphrase,
			NotAfter:   b.NotAfter,
			Kid:        b.Kid,
		}, lic.KeyIssueOptions{Actor: "admin"})
		if err != nil {
			writeErrorFromLicensing(w, err)
			return
		}
		writeOKStatus(w, http.StatusCreated, keyToWire(key))
		return
	}
	// role == "signing" — need an existing active root for (scope, alg).
	roleRoot := lic.RoleRoot
	stateActive := lic.StateActive
	roots, err := h.ctx.Storage.ListKeys(lic.LicenseKeyFilter{
		ScopeID:    b.ScopeID,
		ScopeIDSet: true,
		Alg:        &alg,
		Role:       &roleRoot,
		State:      &stateActive,
	}, lic.PageRequest{Limit: 1})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if len(roots.Items) == 0 {
		writeError(w, 409, "IllegalLifecycleTransition",
			"no active root key for (scope, alg); generate a root first")
		return
	}
	root := roots.Items[0]
	key, err := lic.IssueInitialSigningKey(h.ctx.Storage, h.ctx.Clock, h.ctx.Backends, lic.IssueInitialSigningKeyInput{
		ScopeID:           b.ScopeID,
		Alg:               alg,
		RootKid:           root.Kid,
		RootPassphrase:    h.ctx.RootPassphrase,
		SigningPassphrase: h.ctx.SigningPassphrase,
		NotAfter:          b.NotAfter,
		Kid:               b.Kid,
	}, lic.KeyIssueOptions{Actor: "admin"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOKStatus(w, http.StatusCreated, keyToWire(key))
}

func (h *AdminHandler) handleRotateKey(w http.ResponseWriter, _ *http.Request, id string) {
	key, err := h.ctx.Storage.GetKey(id)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if key == nil {
		writeError(w, 404, "NotFound", "key not found: "+id)
		return
	}
	if key.Role != lic.RoleSigning {
		writeError(w, 400, "BadRequest", "only signing keys may be rotated")
		return
	}
	if h.ctx.RootPassphrase == "" || h.ctx.SigningPassphrase == "" {
		writeError(w, 400, "BadRequest", "root+signing passphrases are not configured on this issuer")
		return
	}
	roleRoot := lic.RoleRoot
	stateActive := lic.StateActive
	roots, err := h.ctx.Storage.ListKeys(lic.LicenseKeyFilter{
		ScopeID:    key.ScopeID,
		ScopeIDSet: true,
		Alg:        &key.Alg,
		Role:       &roleRoot,
		State:      &stateActive,
	}, lic.PageRequest{Limit: 1})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	if len(roots.Items) == 0 {
		writeError(w, 409, "IllegalLifecycleTransition", "no active root key for (scope, alg)")
		return
	}
	root := roots.Items[0]
	res, err := lic.RotateSigningKey(h.ctx.Storage, h.ctx.Clock, h.ctx.Backends, lic.RotateSigningKeyInput{
		ScopeID:           key.ScopeID,
		Alg:               key.Alg,
		RootKid:           root.Kid,
		RootPassphrase:    h.ctx.RootPassphrase,
		SigningPassphrase: h.ctx.SigningPassphrase,
	}, lic.RotateSigningKeyOptions{Actor: "admin"})
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writeOK(w, map[string]any{
		"retiring": keyToWire(res.Outgoing),
		"active":   keyToWire(res.Incoming),
	})
}

// ---------------- Audit ----------------

func (h *AdminHandler) routeAudit(w http.ResponseWriter, r *http.Request, segs []string) {
	if len(segs) > 0 && segs[0] != "" {
		writeError(w, 404, "NotFound", "no handler for "+r.Method+" "+r.URL.Path)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, 405, "MethodNotAllowed", "method "+r.Method+" not allowed for "+r.URL.Path)
		return
	}
	page, err := parsePageRequest(r)
	if err != nil {
		writeError(w, 400, "BadRequest", err.Error())
		return
	}
	filter := lic.AuditLogFilter{}
	if v := stringQuery(r, "license_id"); v != nil {
		filter.LicenseID = v
		filter.LicenseIDSet = true
	}
	if v := stringQuery(r, "scope_id"); v != nil {
		filter.ScopeID = v
		filter.ScopeIDSet = true
	}
	if v := stringQuery(r, "event"); v != nil {
		filter.Event = v
	}
	p, err := h.ctx.Storage.ListAudit(filter, page)
	if err != nil {
		writeErrorFromLicensing(w, err)
		return
	}
	writePage(w, p)
}

// ---------------- Opt* JSON decoding ----------------

// decodeOptString interprets a JSON RawMessage as an OptString patch.
// Returns (OptString, true) if the field was present (either a string or
// literal null), or (_, false) if absent entirely.
func decodeOptString(raw json.RawMessage) (lic.OptString, bool) {
	if len(raw) == 0 {
		return lic.OptString{}, false
	}
	if string(raw) == "null" {
		return lic.OptString{Set: true, Value: nil}, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return lic.OptString{}, false
	}
	return lic.OptString{Set: true, Value: &s}, true
}

// decodeOptInt interprets a JSON RawMessage as an OptInt patch.
func decodeOptInt(raw json.RawMessage) (lic.OptInt, bool) {
	if len(raw) == 0 {
		return lic.OptInt{}, false
	}
	if string(raw) == "null" {
		return lic.OptInt{Set: true, Value: nil}, true
	}
	var n int
	if err := json.Unmarshal(raw, &n); err != nil {
		return lic.OptInt{}, false
	}
	return lic.OptInt{Set: true, Value: &n}, true
}
