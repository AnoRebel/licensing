/**
 * Deactivation.
 *
 * `deactivate(reason)` posts `{ license_key, fingerprint, reason }` to
 * `/deactivate`. On success the issuer revokes the LicenseUsage row and
 * the client clears its local store so a subsequent `validate()` returns
 * `NoToken`.
 *
 * Ordering matters here: the network call MUST succeed before we delete
 * the local token. If we cleared first and the delete-on-server failed,
 * the user would be locked out while still consuming a seat on the
 * issuer side.
 *
 * An exception: if the issuer responds with `InvalidLicenseKey` or
 * `LicenseRevoked`, the local state is stale anyway — the license isn't
 * deactivatable because it no longer exists / is already revoked. We
 * still clear the token in that case; it's what the user asked for and
 * the issuer's authoritative state says the local token is garbage.
 */

import { clientErrors, LicensingClientError } from './errors.ts';
import type { TokenStore } from './token-store.ts';
import { postJson, type TransportOptions } from './transport.ts';

export interface DeactivateOptions extends TransportOptions {
  readonly store: TokenStore;
  readonly licenseKey: string;
  readonly fingerprint: string;
  /** Path under `baseUrl`. Default `/api/licensing/v1/deactivate`. */
  readonly path?: string;
}

export interface DeactivateResult {
  /** True when the issuer confirmed deactivation; false only when we
   *  cleared locally in response to an authoritative "license is gone"
   *  response (InvalidLicenseKey / LicenseRevoked). */
  readonly issuerConfirmed: boolean;
}

/** Shape of the issuer's success data. Fields are optional — issuer may
 *  echo the deactivated-at timestamp but we don't require it. */
type DeactivateResponseData = unknown;

/**
 * Deactivate the current device. Surfaces issuer error codes normally;
 * clears the local store when the issuer says the license-or-usage is
 * already gone.
 */
export async function deactivate(
  reason: string,
  opts: DeactivateOptions,
): Promise<DeactivateResult> {
  if (reason.length === 0) {
    // Require a reason string — not for the issuer (it's advisory), but
    // because "empty reason" is usually a caller bug (passing `undefined`
    // then .toString()). Pass a meaningful string, even `"user-initiated"`.
    throw new Error('deactivate requires a non-empty reason');
  }

  const path = opts.path ?? '/api/licensing/v1/deactivate';
  const body = {
    license_key: opts.licenseKey,
    fingerprint: opts.fingerprint,
    reason,
  };

  try {
    await postJson<DeactivateResponseData>(path, body, opts);
    await opts.store.clear();
    return { issuerConfirmed: true };
  } catch (err) {
    if (err instanceof LicensingClientError && isAlreadyGone(err.code)) {
      // Issuer says the license doesn't exist or is already revoked.
      // Local token is therefore useless — clear it and return a
      // best-effort success. The caller may still observe the original
      // code via a wrapping try/catch if they care.
      await opts.store.clear();
      return { issuerConfirmed: false };
    }
    // Any other error (IssuerUnreachable, SeatLimitExceeded — wouldn't
    // apply here but anyway, RateLimited, ...) leaves local state intact
    // and propagates to the caller.
    throw err;
  }
}

/** Codes under which the local token is definitively stale. */
function isAlreadyGone(code: string): boolean {
  return code === 'InvalidLicenseKey' || code === 'LicenseRevoked';
}

// Re-export so consumers can `instanceof LicensingClientError` without
// pulling in errors.ts directly.
export { clientErrors, LicensingClientError };
