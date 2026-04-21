# licensing/storage

Storage adapters for the licensing issuer. Pick one:

| Adapter | Import path                                       | Use for                    |
|---------|---------------------------------------------------|----------------------------|
| memory  | `github.com/AnoRebel/licensing/storage/memory`    | tests, local dev           |
| postgres| `github.com/AnoRebel/licensing/storage/postgres`  | production (pgx v5)        |
| sqlite  | `github.com/AnoRebel/licensing/storage/sqlite`    | edge, single-node prod     |

All three pass the shared test suite at `licensing/storage/conformance`.

## Postgres

```go
import (
    "github.com/AnoRebel/licensing/storage/postgres"
    "github.com/jackc/pgx/v5/pgxpool"
)

pool, _ := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
if err := postgres.Migrate(ctx, pool); err != nil { panic(err) }
store := postgres.New(pool)
```

Idempotent migrations. `SELECT … FOR UPDATE` on License rows for seat-count
concurrency. `BEFORE UPDATE/DELETE` triggers on `audit_log` enforce
immutability at the DB layer — not just in app code.

## SQLite

Pure-Go driver (`modernc.org/sqlite`). WAL mode, `foreign_keys=on`, and
partial unique indexes for NULLS-NOT-DISTINCT emulation.

```go
import "github.com/AnoRebel/licensing/storage/sqlite"

db, _ := sqlite.Open("licensing.db")
if err := sqlite.Migrate(ctx, db); err != nil { panic(err) }
store := sqlite.New(db)
```

## Memory

```go
store := memory.New() // isolated; perfect for parallel tests
```

No persistence; snapshot-based transactions; full unique-constraint
enforcement. Not for production.
