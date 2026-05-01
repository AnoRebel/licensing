package sqlite

import (
	"database/sql"
	"fmt"

	"github.com/AnoRebel/licensing/licensing/client"
)

// JtiLedger is the SQLite-backed replay-prevention ledger. It implements
// client.JtiLedger using the jti_uses table created by migration 0003.
//
// Concurrency: SQLite serializes writers automatically; the ledger is
// safe for concurrent use from any number of goroutines. Each
// RecordJtiUse is one INSERT round trip.
type JtiLedger struct {
	db *sql.DB
}

// NewJtiLedger constructs a SQLite-backed jti ledger. The caller MUST
// have applied migrations (jti_uses lives in 0003_jti_uses.sql) before
// the first RecordJtiUse call.
func NewJtiLedger(db *sql.DB) *JtiLedger {
	return &JtiLedger{db: db}
}

// RecordJtiUse implements client.JtiLedger.
//
// Strategy: INSERT ... ON CONFLICT DO NOTHING. SQLite returns
// rowsAffected=0 when the conflict fired and no row was inserted,
// rowsAffected=1 on a fresh insert. That distinguishes first-use from
// replay without a separate SELECT.
func (l *JtiLedger) RecordJtiUse(jti string, expSec int64) (bool, error) {
	res, err := l.db.Exec(
		`INSERT INTO jti_uses (jti, expires_at) VALUES (?, ?)
		 ON CONFLICT(jti) DO NOTHING`,
		jti, expSec,
	)
	if err != nil {
		return false, fmt.Errorf("record jti use: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		// SQLite always supports RowsAffected; if this errors something
		// is genuinely wrong with the driver.
		return false, fmt.Errorf("rows affected: %w", err)
	}
	return n == 1, nil
}

// PruneExpired implements client.JtiLedger. Removes every row whose
// expires_at ≤ nowSec. Idempotent.
func (l *JtiLedger) PruneExpired(nowSec int64) (int, error) {
	res, err := l.db.Exec(
		`DELETE FROM jti_uses WHERE expires_at <= ?`,
		nowSec,
	)
	if err != nil {
		return 0, fmt.Errorf("prune jti_uses: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("rows affected: %w", err)
	}
	return int(n), nil
}

// Compile-time interface check.
var _ client.JtiLedger = (*JtiLedger)(nil)
