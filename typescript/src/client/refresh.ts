/**
 * Token refresh.
 *
 * Refresh is either PROACTIVE (lifetime < threshold, default 25%) or
 * FORCED (`now > force_online_after`). The two paths behave differently
 * on network failure:
 *
 *   - Proactive: swallow the error. We still have a perfectly valid
 *     token; coming back later is fine. The caller may surface a log
 *     line but MUST NOT fail the user.
 *   - Forced: either succeed, enter grace (if not already in grace and
 *     a grace window is configured), or surface `RequiresOnlineRefresh`.
 *     Grace is a mercy window for a server being temporarily unreachable
 *     past the hard-deadline the issuer chose.
 *
 * A successful refresh always clears `graceStartSec` — whatever outage
 * caused grace is over, the issuer and client are back in sync.
 */

import { clientErrors, LicensingClientError } from './errors.ts';
import { EMPTY_STATE, type TokenStore } from './token-store.ts';
import { postJson, type TransportOptions } from './transport.ts';
import { peek } from './validate.ts';

export interface RefreshOptions extends TransportOptions {
  readonly store: TokenStore;
  /** Current wall-clock unix seconds. Injected for testability. */
  readonly nowSec: number;
  /** Lifetime fraction below which a proactive refresh fires. Default
   *  0.25. Set to 0 to disable proactive behavior; set to 1.0 to refresh
   *  every call. */
  readonly proactiveThreshold?: number;
  /** Grace-on-unreachable window in seconds. Default 7 days (604_800).
   *  Set to 0 to disable grace entirely — forced refresh failures then
   *  surface `IssuerUnreachable` directly. */
  readonly graceWindowSec?: number;
  /** Path under `baseUrl`. Default `/api/licensing/v1/refresh`. */
  readonly path?: string;
}

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly token: string }
  | { readonly kind: 'not-due'; readonly token: string }
  | { readonly kind: 'grace-entered'; readonly token: string; readonly graceStartSec: number }
  | { readonly kind: 'grace-continued'; readonly token: string; readonly graceStartSec: number };

/** Shape of the issuer's success `data`. Only `token` is mandatory; other
 *  fields (usage_id, license_id) may be returned but aren't needed here. */
interface RefreshResponseData {
  readonly token: unknown;
}

/**
 * Attempt to refresh the stored token. Returns a tagged outcome describing
 * what happened; consumers that only want a boolean "was a network call
 * made" can look at `outcome.kind`.
 *
 * Throws {@link LicensingClientError} for unrecoverable states:
 *   - `NoToken`: nothing stored; activate first.
 *   - `GraceExpired`: grace window elapsed without a successful contact.
 *   - `RequiresOnlineRefresh`: forced deadline past AND grace disabled
 *     AND network failed — there's no legitimate way forward but to
 *     surface the hard error.
 *   - Any issuer-returned error (LicenseRevoked, SeatLimitExceeded, ...).
 */
export async function refresh(opts: RefreshOptions): Promise<RefreshOutcome> {
  const state = await opts.store.read();
  const currentToken = state.token;
  if (currentToken === null) {
    throw clientErrors.noToken();
  }

  // Peek is cheap and tells us if a refresh is due. We deliberately use
  // the unverified peek: if the token is tampered, the next `validate()`
  // will catch it — `refresh()` operates on the token the store says we
  // have. Using `validate()` here would also require the caller to pass
  // a registry/keys, which couples the refresh API to the crypto surface.
  const metadata = peek(currentToken);
  const graceWindow = opts.graceWindowSec ?? 7 * 24 * 3600;
  const threshold = opts.proactiveThreshold ?? 0.25;

  // First: check grace already-active. If grace is set and expired, fail
  // closed. If it's set and still valid but we're past force_online_after,
  // we still try the network — a successful refresh clears grace.
  if (state.graceStartSec !== null) {
    if (graceWindow > 0 && opts.nowSec > state.graceStartSec + graceWindow) {
      throw clientErrors.graceExpired(
        `grace started at ${state.graceStartSec}, window ${graceWindow}s, now ${opts.nowSec}`,
      );
    }
  }

  const forced = metadata.forceOnlineAfter !== null && metadata.forceOnlineAfter <= opts.nowSec;
  const proactive = shouldProactiveRefresh(metadata, opts.nowSec, threshold);

  if (!forced && !proactive && state.graceStartSec === null) {
    return { kind: 'not-due', token: currentToken };
  }

  // Attempt the network call.
  try {
    const data = await postJson<RefreshResponseData>(
      opts.path ?? '/api/licensing/v1/refresh',
      { token: currentToken },
      opts,
    );
    if (typeof data.token !== 'string' || data.token.length === 0) {
      throw clientErrors.invalidTokenFormat(
        'issuer returned success but no refreshed token string',
      );
    }
    // Success — clear any grace state.
    await opts.store.write({ token: data.token, graceStartSec: null });
    return { kind: 'refreshed', token: data.token };
  } catch (err) {
    // Only IssuerUnreachable is a candidate for grace. Every other
    // issuer error (revoked, seat-limit, ...) is an authoritative
    // response we must NOT mask with grace — the license actually is
    // in that state.
    if (!(err instanceof LicensingClientError) || err.code !== 'IssuerUnreachable') {
      throw err;
    }
    return await handleUnreachable(
      currentToken,
      state.graceStartSec,
      opts,
      forced,
      graceWindow,
      err,
    );
  }
}

/** Extract-and-named for readability. Decides grace behavior when the
 *  network is down during a refresh attempt. `currentToken` is taken as
 *  a non-nullable string — the caller already proved it's not null. */
async function handleUnreachable(
  currentToken: string,
  existingGraceStartSec: number | null,
  opts: RefreshOptions,
  forced: boolean,
  graceWindow: number,
  err: LicensingClientError,
): Promise<RefreshOutcome> {
  if (!forced) {
    // Proactive refresh that failed: swallow. Caller may log.
    return { kind: 'not-due', token: currentToken };
  }
  if (graceWindow === 0) {
    // Caller opted out of grace. Surface the hard error.
    throw clientErrors.requiresOnlineRefresh(
      `forced refresh failed, grace disabled: ${err.message}`,
    );
  }
  // Forced + network down + grace enabled.
  if (existingGraceStartSec !== null) {
    // Already in grace. Double-check window (we checked on entry, but
    // time may have moved). Past window → GraceExpired.
    if (opts.nowSec > existingGraceStartSec + graceWindow) {
      throw clientErrors.graceExpired(
        `grace started at ${existingGraceStartSec}, window ${graceWindow}s, now ${opts.nowSec}`,
      );
    }
    return {
      kind: 'grace-continued',
      token: currentToken,
      graceStartSec: existingGraceStartSec,
    };
  }
  // Enter grace.
  const graceStartSec = opts.nowSec;
  await opts.store.write({ token: currentToken, graceStartSec });
  return { kind: 'grace-entered', token: currentToken, graceStartSec };
}

/** Return true when the proactive-refresh condition holds. Lifetime is
 *  computed from (nbf → exp) rather than (iat → exp) because nbf is the
 *  effective start: a token issued at T1 but nbf=T2 becomes usable at T2,
 *  and "25% remaining" should be relative to the usable window. */
function shouldProactiveRefresh(
  metadata: { readonly nbf: number; readonly exp: number },
  nowSec: number,
  threshold: number,
): boolean {
  if (threshold <= 0) return false;
  const lifetime = metadata.exp - metadata.nbf;
  if (lifetime <= 0) return true; // degenerate — refresh immediately
  const remaining = metadata.exp - nowSec;
  if (remaining <= 0) return true; // already expired, caller's validate() will fail anyway
  return remaining / lifetime < threshold;
}

// Re-export EMPTY_STATE so callers constructing the module graph don't
// need a separate import just for the token-store types.
export { EMPTY_STATE };
