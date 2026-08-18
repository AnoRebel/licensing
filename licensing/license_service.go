package licensing

import "fmt"

// License creation orchestration — Go port of
// typescript/packages/core/src/license-service.ts.
//
// createLicense wraps the storage-level insert with:
//   - Key generation when omitted (via GenerateLicenseKey).
//   - Key normalization/validation when explicitly passed.
//   - An atomic license.created audit log row written in the same tx.
//   - LicenseKeyConflict surfacing when the adapter rejects a duplicate.
//
// Lifecycle transitions (Activate, Renew, Suspend, ...) live in lifecycle.go.

// CreateLicenseInput is the caller-supplied shape for creating a License
// via the service layer (vs LicenseInput which is the storage-layer shape).
type CreateLicenseInput struct {
	ScopeID        *string
	TemplateID     *string
	ActivatedAt    *string
	ExpiresAt      *string
	GraceUntil     *string
	Meta           map[string]any
	LicensableType string
	LicensableID   string
	LicenseKey     string
	Status         LicenseStatus
	MaxUsages      int
}

// CreateLicenseOptions carries optional settings for CreateLicense.
type CreateLicenseOptions struct {
	// Actor attribution for the license.created audit row. Default "system".
	// ActorID/ActorKind carry the acting principal through to the audit
	// row. Optional: when ActorKind is empty the adapter derives it from
	// Actor, so existing callers keep their previous behaviour.
	ActorID   *string
	Actor     string
	ActorKind ActorKind
}

// CreateLicense creates a license with audit trail, inside a single storage
// transaction. Status defaults to "pending", key is auto-generated when not
// supplied.
func CreateLicense(storage Storage, clock Clock, input CreateLicenseInput, opts CreateLicenseOptions) (*License, error) {
	licenseKey := input.LicenseKey
	if licenseKey == "" {
		licenseKey = GenerateLicenseKey()
	} else {
		normalized, err := AssertLicenseKey(licenseKey)
		if err != nil {
			return nil, err
		}
		licenseKey = normalized
	}

	status := input.Status
	if status == "" {
		status = LicenseStatusPending
	}

	var created *License
	err := storage.WithTransaction(func(tx StorageTx) error {
		var err error
		created, err = tx.CreateLicense(LicenseInput{
			ScopeID:        input.ScopeID,
			TemplateID:     input.TemplateID,
			LicensableType: input.LicensableType,
			LicensableID:   input.LicensableID,
			LicenseKey:     licenseKey,
			Status:         status,
			MaxUsages:      input.MaxUsages,
			ActivatedAt:    input.ActivatedAt,
			ExpiresAt:      input.ExpiresAt,
			GraceUntil:     input.GraceUntil,
			Meta:           input.Meta,
		})
		if err != nil {
			return err
		}
		return writeCreatedAudit(tx, created, clock.NowISO(), opts)
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// FindLicenseByKey looks up a license by its user-facing key,
// case-insensitively. Returns (nil, nil) for not-found or invalid key shape.
func FindLicenseByKey(storage Storage, licenseKey string) (*License, error) {
	normalized, ok := NormalizeLicenseKey(licenseKey)
	if !ok {
		return nil, nil
	}
	return storage.GetLicenseByKey(normalized)
}

func writeCreatedAudit(tx StorageTx, license *License, occurredAt string, opts CreateLicenseOptions) error {
	actor := opts.Actor
	if actor == "" {
		actor = "system"
	}
	_, err := tx.AppendAudit(AuditLogInput{
		LicenseID: &license.ID,
		ScopeID:   license.ScopeID,
		Actor:     actor,
		ActorKind: opts.ActorKind,
		ActorID:   opts.ActorID,
		Event:     "license.created",
		NewState: map[string]any{
			"status":      string(license.Status),
			"license_key": license.LicenseKey,
			"max_usages":  license.MaxUsages,
			"expires_at":  license.ExpiresAt,
			"grace_until": license.GraceUntil,
			"template_id": license.TemplateID,
		},
		OccurredAt: occurredAt,
	})
	return err
}

// RotateLicenseKeyOptions configures RotateLicenseKey.
type RotateLicenseKeyOptions struct {
	ActorID   *string
	Actor     string
	ActorKind ActorKind
}

// RotateLicenseKeyResult reports what a rotation did.
type RotateLicenseKeyResult struct {
	License *License
	// RevokedUsageIDs lists the seats revoked by the rotation.
	//
	// The prior key is deliberately NOT returned: the caller already held it
	// before rotating, and echoing a just-invalidated secret back through
	// another layer only widens where it can be logged.
	RevokedUsageIDs []string
}

// RotateLicenseKey issues a fresh license_key and revokes every active
// seat, forcing each device to re-activate with the new key.
//
// This is leak response, not routine maintenance. Every copy of the old key
// already distributed to the customer stops working, so the operator must
// deliver the new one out of band. Seats are revoked deliberately: a
// rotation that left existing devices running would not contain a leaked
// key, which is the only reason to rotate.
//
// license_key is otherwise immutable — LicensePatch.LicenseKey exists for
// this function alone and PATCH /admin/licenses/{id} cannot reach it, so
// the mutation stays explicit and auditable rather than a side effect of an
// ordinary update.
//
// Revoked licenses are refused: revoked is terminal, and handing out a new
// key for a dead license would imply it could be used.
func RotateLicenseKey(
	storage Storage,
	clock Clock,
	licenseID string,
	opts RotateLicenseKeyOptions,
) (*RotateLicenseKeyResult, error) {
	result := &RotateLicenseKeyResult{}
	err := storage.WithTransaction(func(tx StorageTx) error {
		license, err := tx.GetLicense(licenseID)
		if err != nil {
			return err
		}
		if license == nil {
			return newError(CodeLicenseNotFound,
				fmt.Sprintf("license not found: %s", licenseID),
				map[string]any{"id": licenseID})
		}
		if license.Status == LicenseStatusRevoked {
			return newError(CodeLicenseRevoked,
				"license is revoked; its key cannot be rotated", nil)
		}

		newKey := GenerateLicenseKey()
		updated, err := tx.UpdateLicense(license.ID, LicensePatch{LicenseKey: &newKey})
		if err != nil {
			return err
		}
		result.License = updated

		now := clock.NowISO()
		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}

		// Revoke every live seat. Done inside the same transaction as the
		// key change so a partial rotation cannot exist: either the key is
		// new and the seats are gone, or neither happened.
		cursor := ""
		for {
			page, err := tx.ListUsages(
				LicenseUsageFilter{
					LicenseID: &license.ID,
					Status:    []UsageStatus{UsageStatusActive},
				},
				PageRequest{Limit: 500, Cursor: cursor},
			)
			if err != nil {
				return err
			}
			for i := range page.Items {
				u := page.Items[i]
				if _, err := tx.UpdateUsage(u.ID, LicenseUsagePatch{
					Status:    ptr(UsageStatusRevoked),
					RevokedAt: OptString{Set: true, Value: &now},
				}); err != nil {
					return err
				}
				result.RevokedUsageIDs = append(result.RevokedUsageIDs, u.ID)
			}
			if page.Cursor == "" {
				break
			}
			cursor = page.Cursor
		}

		// One audit row for the rotation itself. The key values are
		// deliberately absent from both states — writing the new key into an
		// append-only log that operators and support staff can read would
		// leak the very secret the rotation exists to protect.
		if _, err := tx.AppendAudit(AuditLogInput{
			LicenseID: &license.ID,
			ScopeID:   license.ScopeID,
			Actor:     actor,
			ActorKind: opts.ActorKind,
			ActorID:   opts.ActorID,
			Event:     "license.key_rotated",
			PriorState: map[string]any{
				"active_usages": len(result.RevokedUsageIDs),
			},
			NewState: map[string]any{
				"active_usages":  0,
				"usages_revoked": len(result.RevokedUsageIDs),
			},
			OccurredAt: now,
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
