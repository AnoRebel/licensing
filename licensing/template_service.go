package licensing

// Template CRUD + template-backed license creation — Go port of
// typescript/packages/core/src/template-service.ts.

import (
	"fmt"
	"maps"
	"time"
)

// CreateTemplateInput is the caller-supplied shape for creating a template.
type CreateTemplateInput struct {
	ScopeID             *string
	ForceOnlineAfterSec *int
	Entitlements        map[string]any
	Meta                map[string]any
	Name                string
	MaxUsages           int
	TrialDurationSec    int
	GraceDurationSec    int
}

// CreateTemplateOptions carries optional settings.
type CreateTemplateOptions struct {
	Actor string
}

// CreateTemplate creates a template with validation and audit trail.
func CreateTemplate(storage Storage, clock Clock, input CreateTemplateInput, opts CreateTemplateOptions) (*LicenseTemplate, error) {
	if input.MaxUsages < 1 {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("template.max_usages must be >= 1 (got %d)", input.MaxUsages), nil)
	}
	if input.TrialDurationSec < 0 {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("template.trial_duration_sec must be >= 0 (got %d)", input.TrialDurationSec), nil)
	}
	if input.GraceDurationSec < 0 {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("template.grace_duration_sec must be >= 0 (got %d)", input.GraceDurationSec), nil)
	}

	entitlements := input.Entitlements
	if entitlements == nil {
		entitlements = map[string]any{}
	}
	meta := input.Meta
	if meta == nil {
		meta = map[string]any{}
	}

	var created *LicenseTemplate
	err := storage.WithTransaction(func(tx StorageTx) error {
		var err error
		created, err = tx.CreateTemplate(LicenseTemplateInput{
			ScopeID:             input.ScopeID,
			Name:                input.Name,
			MaxUsages:           input.MaxUsages,
			TrialDurationSec:    input.TrialDurationSec,
			GraceDurationSec:    input.GraceDurationSec,
			ForceOnlineAfterSec: input.ForceOnlineAfterSec,
			Entitlements:        entitlements,
			Meta:                meta,
		})
		if err != nil {
			return err
		}

		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		_, err = tx.AppendAudit(AuditLogInput{
			ScopeID: created.ScopeID,
			Actor:   actor,
			Event:   "template.created",
			NewState: map[string]any{
				"template_id":        created.ID,
				"name":               created.Name,
				"max_usages":         created.MaxUsages,
				"trial_duration_sec": created.TrialDurationSec,
				"grace_duration_sec": created.GraceDurationSec,
			},
			OccurredAt: clock.NowISO(),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// ---------- createLicenseFromTemplate ----------

// CreateLicenseFromTemplateInput is the caller-supplied shape. Fields
// wrapped in OptString distinguish "omitted (inherit from template)"
// from "explicitly set to null".
type CreateLicenseFromTemplateInput struct {
	ScopeID        OptStringOverride
	ExpiresAt      OptStringOverride
	GraceUntil     OptStringOverride
	MaxUsages      *int
	Meta           map[string]any
	TemplateID     string
	LicensableType string
	LicensableID   string
	LicenseKey     string
	Status         LicenseStatus
}

// OptStringOverride distinguishes "field not supplied" (Set=false) from
// "explicitly set" (Set=true, Value may be nil for explicit null).
type OptStringOverride struct {
	Value *string
	Set   bool
}

// CreateLicenseFromTemplate creates a license using a template's defaults
// with field-level overrides. Delegates to CreateLicense so the created
// row flows through the same audit logging path.
func CreateLicenseFromTemplate(
	storage Storage, clock Clock,
	input CreateLicenseFromTemplateInput,
	opts CreateLicenseOptions,
) (*License, error) {
	template, err := storage.GetTemplate(input.TemplateID)
	if err != nil {
		return nil, err
	}
	if template == nil {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("template not found: %s", input.TemplateID), nil)
	}

	// Resolve scope: caller override → template default.
	var scopeID *string
	if input.ScopeID.Set {
		scopeID = input.ScopeID.Value
	} else {
		scopeID = template.ScopeID
	}

	// Resolve max_usages: caller override → template default.
	maxUsages := template.MaxUsages
	if input.MaxUsages != nil {
		maxUsages = *input.MaxUsages
	}

	// Trial/grace computation. Applied only when caller left the field
	// unset — explicit null is honored as "no expiry".
	now := clock.NowISO()

	var expiresAt *string
	if input.ExpiresAt.Set {
		expiresAt = input.ExpiresAt.Value
	} else {
		expiresAt = computeExpiresAt(now, template.TrialDurationSec)
	}

	var graceUntil *string
	if input.GraceUntil.Set {
		graceUntil = input.GraceUntil.Value
	} else {
		graceUntil = computeGraceUntil(expiresAt, template.GraceDurationSec)
	}

	// Snapshot entitlements into license.meta at creation time.
	mergedMeta := make(map[string]any)
	if len(template.Entitlements) > 0 {
		mergedMeta["entitlements"] = template.Entitlements
	}
	if template.ForceOnlineAfterSec != nil {
		mergedMeta["force_online_after_sec"] = *template.ForceOnlineAfterSec
	}
	// Caller meta overwrites template-derived keys.
	maps.Copy(mergedMeta, input.Meta)

	return CreateLicense(storage, clock, CreateLicenseInput{
		ScopeID:        scopeID,
		TemplateID:     &template.ID,
		LicensableType: input.LicensableType,
		LicensableID:   input.LicensableID,
		LicenseKey:     input.LicenseKey,
		Status:         input.Status,
		MaxUsages:      maxUsages,
		ExpiresAt:      expiresAt,
		GraceUntil:     graceUntil,
		Meta:           mergedMeta,
	}, opts)
}

// ---------- internals ----------

// computeExpiresAt returns now + trialDurationSec, or nil if duration <= 0.
func computeExpiresAt(now string, trialDurationSec int) *string {
	if trialDurationSec <= 0 {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, now)
	if err != nil {
		return nil
	}
	expires := t.Add(time.Duration(trialDurationSec) * time.Second)
	s := expires.UTC().Format("2006-01-02T15:04:05.000000Z")
	return &s
}

// computeGraceUntil returns expiresAt + graceDurationSec, or nil if
// expiresAt is nil or duration <= 0.
func computeGraceUntil(expiresAt *string, graceDurationSec int) *string {
	if expiresAt == nil || graceDurationSec <= 0 {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *expiresAt)
	if err != nil {
		return nil
	}
	grace := t.Add(time.Duration(graceDurationSec) * time.Second)
	s := grace.UTC().Format("2006-01-02T15:04:05.000000Z")
	return &s
}
