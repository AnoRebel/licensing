package licensing

// Token issuance — Go port of
// typescript/packages/core/src/token-service.ts.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// IssueTokenInput carries the caller-supplied parameters for issuing a
// LIC1 token.
type IssueTokenInput struct {
	ForceOnlineAfter OptIntOverride
	Entitlements     OptEntitlements
	License          *License
	Usage            *LicenseUsage
	Meta             map[string]any
	// TransparencyHook is an optional callback fired after a token is
	// successfully signed. It receives the token's identifying metadata
	// + a SHA-256 hash of the full wire-token bytes; operators MAY mirror
	// this to an externally-verifiable append-only store (S3 with object
	// lock, AWS QLDB, immudb, a managed CT-style log) so a stolen-key
	// attacker who mints tokens cannot do so without leaving a trail
	// on the operator's transparency vendor.
	//
	// The hook is fire-and-forget: any retry / async / error-surfacing
	// concern lives in the operator's wrapper. The token is already
	// signed and returned to the caller by the time the hook fires;
	// hook failures do NOT fail the issuance.
	//
	// Leave nil to disable; the hook costs ~zero when unset.
	TransparencyHook  TransparencyHook
	Alg               KeyAlg
	SigningPassphrase string
	TTLSeconds        int
}

// TransparencyHook is the signature of the post-issue callback. The
// event carries enough metadata to identify the token and verify its
// integrity against an external log, without leaking the token bytes
// themselves.
type TransparencyHook func(event TokenIssuedEvent)

// TokenIssuedEvent is the payload passed to TransparencyHook. All
// fields are non-empty for a successful issue. TokenSHA256 is the
// lowercase-hex SHA-256 of the full wire-token string (i.e. the same
// bytes the consumer receives), 64 chars.
type TokenIssuedEvent struct {
	Jti         string
	LicenseID   string
	UsageID     string
	Kid         string
	TokenSHA256 string
	Iat         int64
	Exp         int64
}

// OptIntOverride distinguishes "not supplied" from "explicitly set".
type OptIntOverride struct {
	Value *int64
	Set   bool
}

// OptEntitlements distinguishes "not supplied" from "explicitly set".
type OptEntitlements struct {
	Value map[string]any
	Set   bool
}

// IssueTokenResult is the return value of IssueToken.
type IssueTokenResult struct {
	Token string
	Kid   string
	Jti   string
	Iat   int64
	Exp   int64
}

// IssueToken builds and signs a LIC1 token for (license, usage). It does
// not persist anything — token issuance is stateless at the storage layer.
func IssueToken(
	storage Storage, clock Clock,
	backends *AlgorithmRegistry,
	input IssueTokenInput,
) (*IssueTokenResult, error) {
	if input.TTLSeconds <= 0 {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("issueToken.ttlSeconds must be > 0 (got %d)", input.TTLSeconds), nil)
	}
	if input.Usage.LicenseID != input.License.ID {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("usage.license_id (%s) does not belong to license %s",
				input.Usage.LicenseID, input.License.ID), nil)
	}
	if input.Usage.Status != UsageStatusActive {
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("usage %s is not active (status=%s)",
				input.Usage.ID, input.Usage.Status), nil)
	}

	nowISO := clock.NowISO()
	status := EffectiveStatus(input.License, nowISO)
	switch status {
	case LicenseStatusActive, LicenseStatusGrace:
		// OK — issuable.
	case LicenseStatusPending:
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("license %s is still pending — activate via registerUsage first",
				input.License.ID), nil)
	case LicenseStatusSuspended:
		return nil, newError(CodeLicenseSuspended, "license is suspended", nil)
	case LicenseStatusRevoked:
		return nil, newError(CodeLicenseRevoked, "license is revoked", nil)
	case LicenseStatusExpired:
		return nil, newError(CodeLicenseExpired, "license has expired", nil)
	default:
		return nil, newError(CodeTokenMalformed,
			fmt.Sprintf("unknown effective status: %s", status), nil)
	}

	// Load the active signing key: scoped first, global fallback.
	signing, err := findActiveSigningKey(storage, input.License.ScopeID, input.Alg)
	if err != nil {
		return nil, err
	}
	if signing == nil {
		msg := fmt.Sprintf("no active global signing key for alg=%s", input.Alg)
		if input.License.ScopeID != nil {
			msg = fmt.Sprintf(
				"no active signing key for scope=%s alg=%s (and no global fallback)",
				*input.License.ScopeID, input.Alg)
		}
		return nil, newError(CodeUnknownKid, msg, nil)
	}

	// Defense-in-depth: key scope must match license scope or be global.
	if signing.ScopeID != nil {
		licenseScopeMatch := input.License.ScopeID != nil && *signing.ScopeID == *input.License.ScopeID
		if !licenseScopeMatch {
			scopeLabel := "global"
			if input.License.ScopeID != nil {
				scopeLabel = *input.License.ScopeID
			}
			return nil, newError(CodeUnknownKid,
				fmt.Sprintf("signing key %s scope (%s) does not match license scope (%s)",
					signing.Kid, *signing.ScopeID, scopeLabel), nil)
		}
	}

	// Resolve scope slug for the `scope` claim.
	scopeSlug := ""
	if input.License.ScopeID != nil {
		scope, err := storage.GetScope(*input.License.ScopeID)
		if err != nil {
			return nil, err
		}
		if scope == nil {
			return nil, newError(CodeTokenMalformed,
				fmt.Sprintf("license references unknown scope %s", *input.License.ScopeID), nil)
		}
		scopeSlug = scope.Slug
	}

	iat := unixSeconds(nowISO)
	exp := iat + int64(input.TTLSeconds)
	jti := NewUUIDv7()

	// Build payload.
	payload := LIC1Payload{
		"jti":               jti,
		"iat":               iat,
		"nbf":               iat,
		"exp":               exp,
		"scope":             scopeSlug,
		"license_id":        input.License.ID,
		"usage_id":          input.Usage.ID,
		"usage_fingerprint": input.Usage.Fingerprint,
		"status":            string(status),
		"max_usages":        int64(input.License.MaxUsages),
	}

	forceOnlineAfter, err := resolveForceOnlineAfter(input, iat)
	if err != nil {
		return nil, err
	}
	if forceOnlineAfter != nil {
		payload["force_online_after"] = *forceOnlineAfter
	}

	entitlements := resolveEntitlements(input)
	if entitlements != nil {
		payload["entitlements"] = entitlements
	}

	if input.Meta != nil {
		payload["meta"] = input.Meta
	}

	// Import signing key's private material. Use a minimal KeyStore adapter
	// that only serves the one key we already loaded.
	hierarchy, err := NewKeyHierarchy(KeyHierarchyOptions{
		Store:    &singleKeyStore{key: signing},
		Registry: backends,
		Clock:    clock,
	})
	if err != nil {
		return nil, err
	}
	_, handle, err := hierarchy.ImportSigningPrivate(signing.Kid, input.SigningPassphrase)
	if err != nil {
		return nil, err
	}

	backend, err := backends.Get(input.Alg)
	if err != nil {
		return nil, err
	}

	header := LIC1Header{V: 1, Typ: "lic", Alg: input.Alg, Kid: signing.Kid}
	token, err := Encode(EncodeOptions{
		Header:     header,
		Payload:    payload,
		PrivateKey: handle,
		Backend:    backend,
	})
	if err != nil {
		return nil, err
	}

	// Fire the transparency hook. Hash the full wire-token bytes —
	// that's what an external log would record and what a third party
	// would compare against the operator's local audit log to detect a
	// stolen-key issuance. SHA-256 of UTF-8 bytes; 64-char lowercase hex.
	if input.TransparencyHook != nil {
		sum := sha256.Sum256([]byte(token))
		input.TransparencyHook(TokenIssuedEvent{
			Jti:         jti,
			LicenseID:   input.License.ID,
			UsageID:     input.Usage.ID,
			Kid:         signing.Kid,
			Iat:         iat,
			Exp:         exp,
			TokenSHA256: hex.EncodeToString(sum[:]),
		})
	}

	return &IssueTokenResult{
		Token: token,
		Kid:   signing.Kid,
		Iat:   iat,
		Exp:   exp,
		Jti:   jti,
	}, nil
}

// ---------- internals ----------

// findActiveSigningKey finds the active signing key for a scope and alg.
// Tries scoped first, falls back to global.
func findActiveSigningKey(storage Storage, scopeID *string, alg KeyAlg) (*LicenseKey, error) {
	if scopeID != nil {
		key, err := findFirstActiveKey(storage, scopeID, alg)
		if err != nil {
			return nil, err
		}
		if key != nil {
			return key, nil
		}
	}
	// Global fallback (or direct query when scopeID was nil).
	return findFirstActiveKey(storage, nil, alg)
}

func findFirstActiveKey(storage Storage, scopeID *string, alg KeyAlg) (*LicenseKey, error) {
	role := RoleSigning
	state := StateActive
	cursor := ""
	for {
		page, err := storage.ListKeys(LicenseKeyFilter{
			ScopeID:    scopeID,
			ScopeIDSet: true,
			Alg:        &alg,
			Role:       &role,
			State:      &state,
		}, PageRequest{Limit: 50, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		if len(page.Items) > 0 {
			return &page.Items[0], nil
		}
		if page.Cursor == "" {
			return nil, nil
		}
		cursor = page.Cursor
	}
}

const forceOnlineMaxSec int64 = 10 * 365 * 24 * 3600

func resolveForceOnlineAfter(input IssueTokenInput, iat int64) (*int64, error) {
	if input.ForceOnlineAfter.Set {
		if input.ForceOnlineAfter.Value == nil {
			return nil, nil
		}
		v := *input.ForceOnlineAfter.Value
		if err := validateForceOnlineDeadline(v, iat, "forceOnlineAfter"); err != nil {
			return nil, err
		}
		return &v, nil
	}
	// Fall back to license.meta.force_online_after_sec (relative duration).
	if input.License.Meta == nil {
		return nil, nil
	}
	raw, ok := input.License.Meta["force_online_after_sec"]
	if !ok {
		return nil, nil
	}
	sec, ok := toInt64(raw)
	if !ok {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("license.meta.force_online_after_sec must be a positive integer (got %v)", raw), nil)
	}
	if sec <= 0 {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("license.meta.force_online_after_sec must be a positive integer (got %d)", sec), nil)
	}
	if sec > forceOnlineMaxSec {
		return nil, newError(CodeFingerprintRejected,
			fmt.Sprintf("license.meta.force_online_after_sec (%d) exceeds max horizon (%d)", sec, forceOnlineMaxSec), nil)
	}
	abs := iat + sec
	return &abs, nil
}

func validateForceOnlineDeadline(candidate, iat int64, context string) error {
	if candidate < iat {
		return newError(CodeFingerprintRejected,
			fmt.Sprintf("%s (%d) is in the past (iat=%d)", context, candidate, iat), nil)
	}
	if candidate > iat+forceOnlineMaxSec {
		return newError(CodeFingerprintRejected,
			fmt.Sprintf("%s (%d) exceeds max horizon (%d)", context, candidate, iat+forceOnlineMaxSec), nil)
	}
	return nil
}

func resolveEntitlements(input IssueTokenInput) map[string]any {
	if input.Entitlements.Set {
		return input.Entitlements.Value
	}
	if input.License.Meta == nil {
		return nil
	}
	raw, ok := input.License.Meta["entitlements"]
	if !ok || raw == nil {
		return nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

func unixSeconds(iso string) int64 {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return 0
	}
	return t.Unix()
}

// toInt64 attempts to convert a JSON-decoded value to int64.
func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int64:
		return x, true
	case float64:
		if x == float64(int64(x)) {
			return int64(x), true
		}
		return 0, false
	default:
		return 0, false
	}
}

// singleKeyStore is a minimal KeyStore adapter that serves exactly one key.
// Used by IssueToken to satisfy KeyHierarchy.ImportSigningPrivate without a
// full storage tx.
type singleKeyStore struct {
	key *LicenseKey
}

// Put is unreachable — the single-key store is read-only for token issuance.
func (s *singleKeyStore) Put(_ LicenseKey) error {
	return fmt.Errorf("singleKeyStore.Put: unreachable")
}

// Get fetches the record.
func (s *singleKeyStore) Get(_ string) (*LicenseKey, error) {
	return nil, nil
}

// FindByKid finds by kid.
func (s *singleKeyStore) FindByKid(kid string) (*LicenseKey, error) {
	if kid == s.key.Kid {
		return s.key, nil
	}
	return nil, nil
}

// List lists the record.
func (s *singleKeyStore) List(_ KeyStoreFilter) ([]LicenseKey, error) {
	return []LicenseKey{*s.key}, nil
}

// Update updates the record.
func (s *singleKeyStore) Update(_ string, _ LicenseKey) error {
	return fmt.Errorf("singleKeyStore.Update: unreachable")
}
