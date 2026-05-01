package client

import "sync"

// JtiLedger is the optional, opt-in replay-prevention layer. When wired
// into ValidateOptions.JtiLedger, the verifier records each token's jti
// after the existing checks pass and before returning success; a second
// validate of the same token surfaces *ClientError{Code: CodeTokenReplayed}.
//
// The ledger is meaningful only for online verifiers — offline clients
// cannot consult a shared store, so the protocol's offline-first use
// case ignores this layer entirely. Verifiers that DO have storage
// reach (server-side validators, online activation paths) gain
// per-trust-domain replay protection at the cost of one ledger lookup
// per validate.
//
// Implementations MUST be safe for concurrent use.
type JtiLedger interface {
	// RecordJtiUse records that jti has been used.
	//
	// Returns firstUse=true when this is the first time the ledger has
	// seen this jti — caller proceeds. Returns firstUse=false when the
	// jti was already recorded — caller MUST reject the token with
	// CodeTokenReplayed.
	//
	// expSec is the unix-seconds at which the entry MAY be pruned
	// (typically the token's exp + skew). Implementations are NOT
	// required to enforce expiry on read — the token's own exp claim
	// already does. expSec is purely a hint for pruning so the ledger
	// doesn't grow without bound.
	RecordJtiUse(jti string, expSec int64) (firstUse bool, err error)

	// PruneExpired removes entries whose expSec ≤ nowSec. Returns the
	// number of entries removed. Operators MAY call this from their own
	// scheduler; the ledger does NOT prune on its own — first because
	// pruning is operator policy (some want to keep history for audit),
	// second because lazy pruning makes RecordJtiUse latency
	// unpredictable. Implementations MUST be idempotent.
	PruneExpired(nowSec int64) (int, error)
}

// MemoryJtiLedger is an in-process JtiLedger backed by a Go map.
// Suitable for single-instance verifiers and for tests. Multi-instance
// deployments need a shared backing store (Redis, Postgres, …); ship
// your own JtiLedger implementation in that case.
type MemoryJtiLedger struct {
	entries map[string]int64 // jti → expSec
	mu      sync.Mutex
}

// NewMemoryJtiLedger constructs a fresh in-memory ledger.
func NewMemoryJtiLedger() *MemoryJtiLedger {
	return &MemoryJtiLedger{entries: make(map[string]int64)}
}

// RecordJtiUse implements JtiLedger.
func (m *MemoryJtiLedger) RecordJtiUse(jti string, expSec int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.entries[jti]; exists {
		return false, nil
	}
	m.entries[jti] = expSec
	return true, nil
}

// PruneExpired implements JtiLedger.
func (m *MemoryJtiLedger) PruneExpired(nowSec int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	removed := 0
	for jti, exp := range m.entries {
		if exp <= nowSec {
			delete(m.entries, jti)
			removed++
		}
	}
	return removed, nil
}

// Size returns the current number of recorded entries. Useful for
// testing and for operators tracking ledger growth.
func (m *MemoryJtiLedger) Size() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.entries)
}

// Compile-time interface check.
var _ JtiLedger = (*MemoryJtiLedger)(nil)
