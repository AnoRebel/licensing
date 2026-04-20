// Public surface for the `@licensing/sdk/storage` subpath. Re-exports the
// shared `Storage` interface plus input/patch/filter/page DTOs. Adapters
// implement `Storage`; the core lifecycle code consumes it.

export * from './types.ts';
