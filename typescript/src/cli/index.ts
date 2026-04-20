// Public surface for consumers who want to embed the CLI programmatically
// (e.g., tests, or a wrapping tool that pre-processes argv).
//
// Backends are no longer loaded dynamically — the three bundled backends
// (ed25519, rs256-pss, hs256) are imported statically by `./main.ts` from
// `../crypto/index.ts`. If you need to inject a stub / custom backend,
// pass it via `RunOptions.backends` (keyed by alg); the entries override
// the compiled-in defaults.

export { JsonFileKeyStore } from './json-keystore.ts';
export type { ExitCode, RunOptions } from './main.ts';
export { run, USAGE, UsageError } from './main.ts';
