/**
 * Online activation.
 *
 * `activate(licenseKey)` posts `{ license_key, fingerprint, metadata }`
 * to `/activate`, receives a LIC1 token back, and persists it via the
 * configured {@link TokenStore}. On any issuer error (invalid key, seat
 * limit, revoked, suspended, ...), the local store is NOT mutated — the
 * previous token (if any) stays intact so a failed re-activation doesn't
 * strand the user.
 *
 * The function deliberately does NOT call `validate()` on the returned
 * token. The issuer just signed it with a key the client trusts; paying
 * the verification round-trip here would only catch issuer bugs, and in
 * that case the next `validate()` call catches them anyway with a clean
 * error taxonomy.
 */

import { clientErrors } from './errors.ts';
import type { TokenStore } from './token-store.ts';
import { postJson, type TransportOptions } from './transport.ts';

export interface ActivateOptions extends TransportOptions {
  /** Where to persist the resulting token. Required — activation without
   *  persistence is meaningless (next process start would re-activate). */
  readonly store: TokenStore;
  /** Device fingerprint bound into this activation. Usually from
   *  `collectFingerprint(defaultFingerprintSources(appSalt))`. */
  readonly fingerprint: string;
  /** Path under `baseUrl` for the activate endpoint. Default
   *  `/api/licensing/v1/activate`. Exposed for consumers who mount the
   *  handlers at a non-standard prefix. */
  readonly path?: string;
  /** Opaque metadata persisted alongside the activation record on the
   *  issuer side (hostname, app version, ...). MUST be JSON-serializable. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActivateResult {
  readonly token: string;
  /** Echoed usage_id the issuer assigned. */
  readonly usage_id: string;
  /** Echoed license_id (convenient for UI without peeking the token). */
  readonly license_id: string;
}

/** Shape the issuer returns in `data` on success. We intentionally
 *  narrow-typecheck the fields we use; extras are ignored (forward-compat). */
interface ActivateResponseData {
  readonly token: unknown;
  readonly usage_id: unknown;
  readonly license_id: unknown;
}

/**
 * Activate a license key against the issuer. On success, persists the
 * returned token and returns it to the caller alongside the issuer-assigned
 * ids. On failure, the local store is untouched.
 */
export async function activate(licenseKey: string, opts: ActivateOptions): Promise<ActivateResult> {
  if (licenseKey.length === 0) {
    throw clientErrors.invalidLicenseKey('license key must be a non-empty string');
  }
  if (opts.fingerprint.length === 0) {
    throw clientErrors.fingerprintMismatch('fingerprint must be a non-empty string');
  }

  const path = opts.path ?? '/api/licensing/v1/activate';
  const body = {
    license_key: licenseKey,
    fingerprint: opts.fingerprint,
    // Metadata is optional; send `{}` rather than omitting so the
    // issuer's input validation can be uniform (required property,
    // default empty).
    metadata: opts.metadata ?? {},
  };

  const data = await postJson<ActivateResponseData>(path, body, opts);

  // Defend against a malformed success envelope — unlikely but cheap.
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw clientErrors.invalidTokenFormat('issuer returned success but no token string');
  }
  if (typeof data.usage_id !== 'string' || typeof data.license_id !== 'string') {
    throw clientErrors.invalidTokenFormat(
      'issuer returned success but usage_id/license_id missing or not strings',
    );
  }

  // Persist BEFORE returning — if the write fails, the caller sees the
  // underlying I/O error and can decide whether to retry. We do not
  // swallow store errors: an activation that didn't persist is worse than
  // a failed activation because the user thinks they're licensed.
  await opts.store.write({
    token: data.token,
    // Fresh activation clears any lingering grace-start from a prior
    // failed-refresh cycle.
    graceStartSec: null,
  });

  return {
    token: data.token,
    usage_id: data.usage_id,
    license_id: data.license_id,
  };
}
