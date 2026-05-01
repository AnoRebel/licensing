package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AnoRebel/licensing/licensing/client"
)

// JtiLedger is the Postgres-backed replay-prevention ledger. It
// implements client.JtiLedger using the jti_uses table created by
// migration 0003.
//
// Concurrency: pgxpool.Pool serializes per-connection access; the
// ledger is safe for concurrent use from any number of goroutines.
// Each RecordJtiUse is one INSERT round trip.
type JtiLedger struct {
	pool *pgxpool.Pool
}

// NewJtiLedger constructs a Postgres-backed jti ledger. The caller
// MUST have applied migrations (jti_uses lives in 0003_jti_uses.sql)
// before the first RecordJtiUse call.
func NewJtiLedger(pool *pgxpool.Pool) *JtiLedger {
	return &JtiLedger{pool: pool}
}

// RecordJtiUse implements client.JtiLedger.
//
// Strategy: INSERT ... ON CONFLICT DO NOTHING. The CommandTag's
// RowsAffected returns 0 on conflict, 1 on fresh insert, distinguishing
// first-use from replay without a separate SELECT.
func (l *JtiLedger) RecordJtiUse(jti string, expSec int64) (bool, error) {
	tag, err := l.pool.Exec(
		context.Background(),
		`INSERT INTO jti_uses (jti, expires_at) VALUES ($1, $2)
		 ON CONFLICT (jti) DO NOTHING`,
		jti, expSec,
	)
	if err != nil {
		return false, fmt.Errorf("record jti use: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// PruneExpired implements client.JtiLedger. Removes every row whose
// expires_at ≤ nowSec. Idempotent.
func (l *JtiLedger) PruneExpired(nowSec int64) (int, error) {
	tag, err := l.pool.Exec(
		context.Background(),
		`DELETE FROM jti_uses WHERE expires_at <= $1`,
		nowSec,
	)
	if err != nil {
		return 0, fmt.Errorf("prune jti_uses: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// Compile-time interface check.
var _ client.JtiLedger = (*JtiLedger)(nil)
