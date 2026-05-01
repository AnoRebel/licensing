// Public surface for `@anorebel/licensing/storage/sqlite`.
//
// `SqliteStorage` implements the `Storage` interface from
// `@anorebel/licensing/storage`. The canonical schema description is re-exported
// so the parity test can pull it without reaching into src/.
//
// Migrations are exposed via a subpath (`@anorebel/licensing/storage/sqlite/migrations`)
// so deploy scripts can run them without instantiating an adapter.

export { type SqliteAdapterOptions, SqliteStorage } from './adapter.ts';
export { SqliteJtiLedger } from './jti-ledger.ts';
export { SQLITE_SCHEMA } from './schema.ts';
