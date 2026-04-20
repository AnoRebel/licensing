/**
 * `@licensing/sdk/client` — public surface.
 *
 * Offline-first consumer of LIC1 tokens issued by `@licensing/sdk`:
 *
 *   - {@link validate}/{@link peek}           — offline validation (no network)
 *   - {@link activate}                        — first-time online activation
 *   - {@link refresh}                         — proactive + forced refresh,
 *                                               grace-on-unreachable
 *   - {@link createHeartbeat}/{@link sendOneHeartbeat}
 *                                             — background liveness signal
 *   - {@link deactivate}                      — release a seat
 *
 * Storage is pluggable via {@link TokenStore}; defaults are provided
 * ({@link FileTokenStore}, {@link MemoryTokenStore}). Fingerprinting is
 * pluggable via {@link FingerprintSource}; a canonical default source
 * list is available via {@link defaultFingerprintSources}.
 *
 * Errors converge into a single {@link LicensingClientError} class with a
 * typed {@link ClientErrorCode} — branch on `.code`, not `instanceof`
 * trees.
 */

export {
  type ActivateOptions,
  type ActivateResult,
  activate,
} from './activate.ts';
export {
  type DeactivateOptions,
  type DeactivateResult,
  deactivate,
} from './deactivate.ts';
export {
  type ClientErrorCode,
  clientErrors,
  fromIssuerCode,
  LicensingClientError,
} from './errors.ts';
export {
  collectFingerprint,
  defaultFingerprintSources,
  type FingerprintSource,
  fingerprintFromSources,
} from './fingerprint.ts';
export {
  createHeartbeat,
  type Heartbeat,
  type HeartbeatOptions,
  sendOneHeartbeat,
} from './heartbeat.ts';
export {
  type RefreshOptions,
  type RefreshOutcome,
  refresh,
} from './refresh.ts';
export {
  EMPTY_STATE,
  FileTokenStore,
  MemoryTokenStore,
  type StoredTokenState,
  type TokenStore,
} from './token-store.ts';
export {
  type FetchImpl,
  isClientError,
  postJson,
  type TransportOptions,
} from './transport.ts';
export {
  type PeekResult,
  peek,
  type ValidateOptions,
  type ValidateResult,
  validate,
} from './validate.ts';
