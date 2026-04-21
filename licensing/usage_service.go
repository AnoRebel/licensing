package licensing

// Usage (seat) registration and revocation — Go port of
// typescript/packages/core/src/usage-service.ts.
//
// Semantics (enforced atomically inside a single storage transaction):
//
//  1. Re-register by same fingerprint is idempotent — returns the existing
//     active usage without creating a new row.
//  2. When active seat count < max_usages, create a new active usage row.
//     If this is the license's first usage AND status is pending,
//     atomically promote to active.
//  3. When active seat count >= max_usages, return SeatLimitExceeded.
//  4. Usable-status guard: active, pending, grace are allowed. Suspended,
//     revoked, expired are rejected with their respective error codes.

import "fmt"

// RegisterUsageInput is the caller-supplied shape for registering a usage.
type RegisterUsageInput struct {
	ClientMeta  map[string]any
	LicenseID   string
	Fingerprint string
}

// RegisterUsageOptions carries optional settings.
type RegisterUsageOptions struct {
	Actor string
}

// RegisterUsageResult is the return value of RegisterUsage.
type RegisterUsageResult struct {
	Usage   *LicenseUsage
	License *License
	// Created is true when this call created a new usage row; false on
	// idempotent re-register.
	Created bool
}

// RegisterUsage registers (or re-registers) a usage against a license.
// Idempotent on fingerprint. Atomic: all reads, writes, and audit rows
// happen inside a single WithTransaction.
func RegisterUsage(storage Storage, clock Clock, input RegisterUsageInput, opts RegisterUsageOptions) (*RegisterUsageResult, error) {
	var result *RegisterUsageResult
	err := storage.WithTransaction(func(tx StorageTx) error {
		license, err := tx.GetLicense(input.LicenseID)
		if err != nil {
			return err
		}
		if license == nil {
			return newError(CodeLicenseNotFound,
				fmt.Sprintf("license not found: %s", input.LicenseID), nil)
		}

		if err := assertUsable(license); err != nil {
			return err
		}

		// 1. Idempotent re-register path.
		existing, err := findActiveUsage(tx, input.LicenseID, input.Fingerprint)
		if err != nil {
			return err
		}
		if existing != nil {
			result = &RegisterUsageResult{Usage: existing, License: license, Created: false}
			return nil
		}

		// 2. Seat check: count active usages inside the tx.
		activeCount, err := countActiveUsages(tx, input.LicenseID)
		if err != nil {
			return err
		}
		if activeCount >= license.MaxUsages {
			return newError(CodeSeatLimitExceeded,
				fmt.Sprintf("seat limit exceeded: %d/%d", activeCount, license.MaxUsages),
				map[string]any{"max": license.MaxUsages, "current": activeCount})
		}

		// 3. Insert the usage row.
		now := clock.NowISO()
		usage, err := tx.CreateUsage(LicenseUsageInput{
			LicenseID:    input.LicenseID,
			Fingerprint:  input.Fingerprint,
			Status:       UsageStatusActive,
			RegisteredAt: now,
			ClientMeta:   input.ClientMeta,
		})
		if err != nil {
			return err
		}

		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		if _, err := tx.AppendAudit(AuditLogInput{
			LicenseID: &license.ID,
			ScopeID:   license.ScopeID,
			Actor:     actor,
			Event:     "usage.registered",
			NewState: map[string]any{
				"usage_id":     usage.ID,
				"fingerprint":  usage.Fingerprint,
				"active_count": activeCount + 1,
			},
			OccurredAt: now,
		}); err != nil {
			return err
		}

		// 4. First successful register on a pending license → activate.
		finalLicense := license
		if license.Status == LicenseStatusPending {
			finalLicense, err = Activate(tx, license, clock, TransitionOptions{Actor: actor})
			if err != nil {
				return err
			}
		}

		result = &RegisterUsageResult{Usage: usage, License: finalLicense, Created: true}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// RevokeUsageOptions carries optional settings for RevokeUsage.
type RevokeUsageOptions struct {
	Actor string
}

// RevokeUsage revokes an active usage row. No-op if already revoked.
func RevokeUsage(storage Storage, clock Clock, usageID string, opts RevokeUsageOptions) (*LicenseUsage, error) {
	var revoked *LicenseUsage
	err := storage.WithTransaction(func(tx StorageTx) error {
		usage, err := tx.GetUsage(usageID)
		if err != nil {
			return err
		}
		if usage == nil {
			return newError(CodeFingerprintRejected,
				fmt.Sprintf("usage not found: %s", usageID), nil)
		}
		if usage.Status == UsageStatusRevoked {
			revoked = usage
			return nil
		}

		now := clock.NowISO()
		updated, err := tx.UpdateUsage(usageID, LicenseUsagePatch{
			Status:    ptr(UsageStatusRevoked),
			RevokedAt: OptString{Set: true, Value: &now},
		})
		if err != nil {
			return err
		}

		// Audit via the owning license.
		license, _ := tx.GetLicense(usage.LicenseID)
		actor := opts.Actor
		if actor == "" {
			actor = "system"
		}
		var scopeID *string
		if license != nil {
			scopeID = license.ScopeID
		}
		if _, err := tx.AppendAudit(AuditLogInput{
			LicenseID: &usage.LicenseID,
			ScopeID:   scopeID,
			Actor:     actor,
			Event:     "usage.revoked",
			PriorState: map[string]any{
				"status":      "active",
				"fingerprint": usage.Fingerprint,
			},
			NewState: map[string]any{
				"status":      "revoked",
				"fingerprint": usage.Fingerprint,
			},
			OccurredAt: now,
		}); err != nil {
			return err
		}

		revoked = updated
		return nil
	})
	if err != nil {
		return nil, err
	}
	return revoked, nil
}

// ---------- internals ----------

func assertUsable(license *License) error {
	switch license.Status {
	case LicenseStatusActive, LicenseStatusPending, LicenseStatusGrace:
		return nil
	case LicenseStatusSuspended:
		return newError(CodeLicenseSuspended, "license is suspended", nil)
	case LicenseStatusRevoked:
		return newError(CodeLicenseRevoked, "license is revoked", nil)
	case LicenseStatusExpired:
		return newError(CodeLicenseExpired, "license has expired", nil)
	default:
		return newError(CodeIllegalLifecycleTransition,
			"unknown license status: "+string(license.Status), nil)
	}
}

// findActiveUsage walks usage pages for (license_id, fingerprint, active).
func findActiveUsage(tx StorageTx, licenseID, fingerprint string) (*LicenseUsage, error) {
	statuses := []UsageStatus{UsageStatusActive}
	cursor := ""
	for {
		page, err := tx.ListUsages(
			LicenseUsageFilter{
				LicenseID:   &licenseID,
				Fingerprint: &fingerprint,
				Status:      statuses,
			},
			PageRequest{Limit: 100, Cursor: cursor},
		)
		if err != nil {
			return nil, err
		}
		for i := range page.Items {
			if page.Items[i].Fingerprint == fingerprint {
				return &page.Items[i], nil
			}
		}
		if page.Cursor == "" {
			return nil, nil
		}
		cursor = page.Cursor
	}
}

// countActiveUsages walks usage pages and counts active rows.
func countActiveUsages(tx StorageTx, licenseID string) (int, error) {
	statuses := []UsageStatus{UsageStatusActive}
	count := 0
	cursor := ""
	for {
		page, err := tx.ListUsages(
			LicenseUsageFilter{
				LicenseID: &licenseID,
				Status:    statuses,
			},
			PageRequest{Limit: 500, Cursor: cursor},
		)
		if err != nil {
			return 0, err
		}
		count += len(page.Items)
		if page.Cursor == "" {
			return count, nil
		}
		cursor = page.Cursor
	}
}
