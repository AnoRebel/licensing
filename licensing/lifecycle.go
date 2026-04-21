package licensing

// License lifecycle state machine — Go port of
// typescript/packages/core/src/lifecycle.ts.
//
// State diagram:
//
//	pending → active ↔ suspended
//	active → grace → expired
//	* → revoked (terminal)
//
// "grace" is computed, not persisted: effectiveStatus() dynamically
// determines if a license is in grace (between expires_at and grace_until)
// without a database write. The tick() function can optionally persist this.
//
// Every transition writes a single audit row in the same transaction.
// Functions take a StorageTx handle and MUST be called inside
// Storage.WithTransaction.

// TransitionOptions carries optional actor attribution for audit log entries.
type TransitionOptions struct {
	// Actor defaults to "system" when empty.
	Actor string
}

// RenewOptions extends TransitionOptions with new end timestamps.
type RenewOptions struct {
	ExpiresAt  *string
	GraceUntil *string
	TransitionOptions
	GraceUntilSet bool
}

// ---------- effective-status helper ----------

// EffectiveStatus computes the effective status of a license given a
// clock instant, without mutating storage. Used by read paths that want
// to display "grace" when the license has passed expires_at but is still
// within grace_until, even if the persisted status hasn't been flipped.
func EffectiveStatus(license *License, nowISO string) LicenseStatus {
	switch license.Status {
	case LicenseStatusRevoked, LicenseStatusSuspended,
		LicenseStatusPending, LicenseStatusExpired:
		return license.Status
	}

	// Active or grace — check expiry boundaries.
	if license.ExpiresAt != nil && nowISO >= *license.ExpiresAt {
		if license.GraceUntil != nil && nowISO < *license.GraceUntil {
			return LicenseStatusGrace
		}
		return LicenseStatusExpired
	}
	return license.Status // "active" or already "grace"
}

// ---------- transitions ----------

// Activate transitions pending → active. No-op if already active.
func Activate(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	if err := assertNotRevoked(license); err != nil {
		return nil, err
	}
	if license.Status == LicenseStatusActive {
		return license, nil
	}
	if license.Status != LicenseStatusPending {
		return nil, illegalTransition(license.Status, LicenseStatusActive)
	}
	now := clock.NowISO()
	updated, err := tx.UpdateLicense(license.ID, LicensePatch{
		Status:      ptr(LicenseStatusActive),
		ActivatedAt: OptString{Set: true, Value: &now},
	})
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.activated", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Suspend transitions active → suspended. Revoked is rejected; suspending
// an already-suspended license is a no-op.
func Suspend(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	if err := assertNotRevoked(license); err != nil {
		return nil, err
	}
	if license.Status == LicenseStatusSuspended {
		return license, nil
	}
	now := clock.NowISO()
	updated, err := tx.UpdateLicense(license.ID, LicensePatch{
		Status: ptr(LicenseStatusSuspended),
	})
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.suspended", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Resume transitions suspended → active.
func Resume(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	if err := assertNotRevoked(license); err != nil {
		return nil, err
	}
	if license.Status != LicenseStatusSuspended {
		return nil, illegalTransition(license.Status, LicenseStatusActive)
	}
	now := clock.NowISO()
	updated, err := tx.UpdateLicense(license.ID, LicensePatch{
		Status: ptr(LicenseStatusActive),
	})
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.resumed", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Revoke transitions * → revoked. Terminal. Revoking an already-revoked
// license is a no-op.
func Revoke(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	if license.Status == LicenseStatusRevoked {
		return license, nil
	}
	now := clock.NowISO()
	updated, err := tx.UpdateLicense(license.ID, LicensePatch{
		Status: ptr(LicenseStatusRevoked),
	})
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.revoked", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Expire transitions active|grace → expired. Used by scheduled sweepers
// after grace_until.
func Expire(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	if err := assertNotRevoked(license); err != nil {
		return nil, err
	}
	if license.Status == LicenseStatusExpired {
		return license, nil
	}
	if license.Status == LicenseStatusSuspended || license.Status == LicenseStatusPending {
		return nil, illegalTransition(license.Status, LicenseStatusExpired)
	}
	now := clock.NowISO()
	updated, err := tx.UpdateLicense(license.ID, LicensePatch{
		Status: ptr(LicenseStatusExpired),
	})
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.expired", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Renew transitions expired|active|grace → active with new end timestamps.
// Suspended and revoked licenses cannot be renewed.
func Renew(tx StorageTx, license *License, clock Clock, opts RenewOptions) (*License, error) {
	if err := assertNotRevoked(license); err != nil {
		return nil, err
	}
	if license.Status == LicenseStatusSuspended {
		return nil, illegalTransition(license.Status, LicenseStatusActive)
	}
	now := clock.NowISO()
	patch := LicensePatch{
		Status:    ptr(LicenseStatusActive),
		ExpiresAt: OptString{Set: true, Value: opts.ExpiresAt},
	}
	if opts.GraceUntilSet {
		patch.GraceUntil = OptString{Set: true, Value: opts.GraceUntil}
	}
	updated, err := tx.UpdateLicense(license.ID, patch)
	if err != nil {
		return nil, err
	}
	if err := writeLifecycleAudit(tx, license, updated, "license.renewed", now, opts.Actor); err != nil {
		return nil, err
	}
	return updated, nil
}

// Tick persists any time-driven transition that EffectiveStatus implies.
// Call on a scheduled sweep.
//
//   - active whose expires_at is past and grace_until is future → persist grace
//   - active|grace whose grace_until is past → persist expired
func Tick(tx StorageTx, license *License, clock Clock, opts TransitionOptions) (*License, error) {
	now := clock.NowISO()
	target := EffectiveStatus(license, now)
	if target == license.Status {
		return license, nil
	}
	switch target {
	case LicenseStatusGrace:
		updated, err := tx.UpdateLicense(license.ID, LicensePatch{
			Status: ptr(LicenseStatusGrace),
		})
		if err != nil {
			return nil, err
		}
		if err := writeLifecycleAudit(tx, license, updated, "license.grace_entered", now, opts.Actor); err != nil {
			return nil, err
		}
		return updated, nil

	case LicenseStatusExpired:
		updated, err := tx.UpdateLicense(license.ID, LicensePatch{
			Status: ptr(LicenseStatusExpired),
		})
		if err != nil {
			return nil, err
		}
		if err := writeLifecycleAudit(tx, license, updated, "license.expired", now, opts.Actor); err != nil {
			return nil, err
		}
		return updated, nil
	}
	return license, nil
}

// ---------- internals ----------

func assertNotRevoked(license *License) error {
	if license.Status == LicenseStatusRevoked {
		return newError(CodeLicenseRevoked, "license is revoked", nil)
	}
	return nil
}

func illegalTransition(from, to LicenseStatus) error {
	return newError(CodeIllegalLifecycleTransition,
		"illegal lifecycle transition: "+string(from)+" → "+string(to),
		map[string]any{"from": string(from), "to": string(to)})
}

func writeLifecycleAudit(tx StorageTx, prior, next *License, event, occurredAt, actor string) error {
	if actor == "" {
		actor = "system"
	}
	_, err := tx.AppendAudit(AuditLogInput{
		LicenseID:  &prior.ID,
		ScopeID:    prior.ScopeID,
		Actor:      actor,
		Event:      event,
		PriorState: lifecycleSnapshot(prior),
		NewState:   lifecycleSnapshot(next),
		OccurredAt: occurredAt,
	})
	return err
}

func lifecycleSnapshot(l *License) map[string]any {
	m := map[string]any{
		"status": string(l.Status),
	}
	if l.ActivatedAt != nil {
		m["activated_at"] = *l.ActivatedAt
	} else {
		m["activated_at"] = nil
	}
	if l.ExpiresAt != nil {
		m["expires_at"] = *l.ExpiresAt
	} else {
		m["expires_at"] = nil
	}
	if l.GraceUntil != nil {
		m["grace_until"] = *l.GraceUntil
	} else {
		m["grace_until"] = nil
	}
	return m
}

func ptr[T any](v T) *T { return &v }
