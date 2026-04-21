// Public surface for `@anorebel/licensing/storage/postgres`.
//
// `PostgresStorage` is the main exported class — it implements the `Storage`
// interface declared by `@anorebel/licensing/storage` and is byte-for-byte
// schema-equivalent to `@anorebel/licensing/storage/memory`'s adapter. The canonical
// schema description this adapter reports is re-exported so the parity test
// can pull it without reaching into src/.
//
// Migrations are exposed via a subpath (`@anorebel/licensing/storage/postgres/migrations`)
// so deploy scripts can run them without instantiating an adapter.

export { type PostgresAdapterOptions, PostgresStorage } from './adapter.ts';
export { POSTGRES_SCHEMA } from './schema.ts';
