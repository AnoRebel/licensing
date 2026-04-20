// Public surface for `@licensing/sdk/storage/memory`.
//
// `MemoryStorage` is the single exported class. It implements the
// `Storage` interface declared by `@licensing/sdk/storage`.
//
// The canonical schema description this adapter reports is also re-exported
// so integration tests can pull it without reaching into the package's src/.

export { type MemoryAdapterOptions, MemoryStorage } from './adapter.ts';
export { MEMORY_SCHEMA } from './schema.ts';
