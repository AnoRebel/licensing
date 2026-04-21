package licensing

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
	Actor string
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
		return writeCreatedAudit(tx, created, clock.NowISO(), opts.Actor)
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

func writeCreatedAudit(tx StorageTx, license *License, occurredAt, actor string) error {
	if actor == "" {
		actor = "system"
	}
	_, err := tx.AppendAudit(AuditLogInput{
		LicenseID: &license.ID,
		ScopeID:   license.ScopeID,
		Actor:     actor,
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
