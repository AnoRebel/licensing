// Public surface for `@licensing/sdk/storage/sqlite`.
//
// `SqliteStorage` implements the `Storage` interface from
// `@licensing/sdk/storage`. The canonical schema description is re-exported
// so the parity test can pull it without reaching into src/.
//
// Migrations are exposed via a subpath (`@licensing/sdk/storage/sqlite/migrations`)
// so deploy scripts can run them without instantiating an adapter.

export { type SqliteAdapterOptions, SqliteStorage } from './adapter.ts';
export { SQLITE_SCHEMA } from './schema.ts';
