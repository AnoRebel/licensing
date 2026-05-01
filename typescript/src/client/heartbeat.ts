/**
 * Heartbeat scheduler.
 *
 * A heartbeat is a fire-and-forget signal to the issuer that this device
 * is still active. Default interval 3600s, minimum 60s. The scheduler:
 *
 *   - MUST NOT block application startup. `start()` returns immediately;
 *     the first tick fires after `interval` (not at time zero) so a
 *     failing network on boot doesn't cascade.
 *   - MUST NOT throw from the tick — network failures, issuer errors,
 *     and unexpected exceptions are all swallowed after being routed to
 *     an optional `onError` callback. The user's app keeps running.
 *   - Clears grace on success, parallel to refresh(). Heartbeat and
 *     refresh are both evidence of "we reached the issuer".
 *
 * Scheduling uses `setInterval`. Two traps we avoid:
 *
 *   1. Overlapping ticks. If the issuer is slow and a tick takes longer
 *      than `interval`, we skip the next tick rather than queueing a
 *      second concurrent request. Guarded by `#inflight`.
 *   2. Unref'd timer keeping Node alive. We `unref()` when available so
 *      a CLI that enables heartbeats still exits cleanly on main-script
 *      completion. Browsers ignore unref (no such method); that's fine.
 */

import { clientErrors, LicensingClientError } from './errors.ts';
import type { TokenStore } from './token-store.ts';
import { postJson, type TransportOptions } from './transport.ts';

/**
 * The request body sent to /heartbeat is just `{token}` — the server
 * derives license_id, usage_id, fingerprint, etc. from the verified
 * token's claims. Earlier shapes carried license_key / fingerprint /
 * runtime_version / timestamp fields that were never read by the
 * server; they were removed in this version.
 */
export interface HeartbeatOptions extends TransportOptions {
  readonly store: TokenStore;
  /** Seconds between heartbeats. Minimum 60s — values below are clamped
   *  up with a warning via `onError`. Default 3600. */
  readonly intervalSec?: number;
  /** Path under `baseUrl`. Default `/api/licensing/v1/heartbeat`. */
  readonly path?: string;
  /** Invoked on every tick failure. Heartbeat failures MUST NOT throw
   *  to callers, but observability-conscious apps want to log them. */
  readonly onError?: (err: Error) => void;
  /** Invoked after every successful tick. Primarily useful for tests
   *  and for apps that want to light up a "last seen" UI. */
  readonly onSuccess?: () => void;
}

export interface Heartbeat {
  /** Begin ticking. Safe to call multiple times; extra calls are no-ops. */
  start(): void;
  /** Stop ticking. Safe to call when not started. */
  stop(): void;
  /** Trigger one tick immediately. Returns when the tick completes;
   *  useful for tests or for apps that want to emit a heartbeat on
   *  a specific event (e.g. after a long sleep/resume). */
  tickNow(): Promise<void>;
}

const MIN_INTERVAL_SEC = 60;
const DEFAULT_INTERVAL_SEC = 3600;

/** Shape the issuer returns on a heartbeat. Currently just an ack —
 *  but we accept whatever `data` they send and don't assert shape. */
type HeartbeatResponseData = unknown;

/**
 * Construct a heartbeat scheduler. Does not start until `.start()` is
 * called. Calling this multiple times creates independent schedulers —
 * that's almost never what you want; keep a singleton per process.
 */
export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const interval = Math.max(opts.intervalSec ?? DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC);
  const clamped = (opts.intervalSec ?? DEFAULT_INTERVAL_SEC) < MIN_INTERVAL_SEC;
  const path = opts.path ?? '/api/licensing/v1/heartbeat';

  // Module-private state boxed in closures — avoids a class just to
  // hold two mutable slots.
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;

  if (clamped) {
    opts.onError?.(
      new Error(
        `heartbeat interval ${opts.intervalSec}s below minimum ${MIN_INTERVAL_SEC}s; clamped`,
      ),
    );
  }

  const tick = async (): Promise<void> => {
    if (inflight) return; // overlapping-tick guard
    inflight = true;
    try {
      await tickOnce(opts, path);
    } finally {
      inflight = false;
    }
  };

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        // Fire tick but don't await — setInterval doesn't care. Errors
        // inside tick() are already contained.
        void tick();
      }, interval * 1000);
      // Node: don't keep the event loop alive solely for heartbeats.
      const maybeUnref = (timer as { unref?: () => void }).unref;
      if (typeof maybeUnref === 'function') maybeUnref.call(timer);
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    tickNow: tick,
  };
}

/** Helper used by call sites that just want a synchronous "fire one
 *  heartbeat and return whether it succeeded". Swallows the same errors
 *  that the scheduler would, but returns a boolean so small CLIs can
 *  exit with a nonzero status on repeated failures. */
export async function sendOneHeartbeat(opts: HeartbeatOptions): Promise<boolean> {
  try {
    return await tickOnce(opts, opts.path ?? '/api/licensing/v1/heartbeat');
  } catch (err) {
    opts.onError?.(err instanceof LicensingClientError ? err : new Error(String(err)));
    return false;
  }
}

/**
 * One heartbeat tick. Shared between createHeartbeat() (scheduler) and
 * sendOneHeartbeat() (fire-and-forget) so the protocol behaviour stays
 * in lockstep.
 *
 * Behaviour on the typed-error response shape mirrors the Go client:
 *
 *   - LicenseRevoked / LicenseSuspended: the issuer's authoritative view
 *     says the local token is no longer valid. Clear the store
 *     (CAS-style — only if the store still holds the token we
 *     heartbeated with, so a parallel Refresh that wrote a fresh token
 *     isn't clobbered) and route the typed error through onError.
 *   - IssuerUnreachable / RateLimited / other transport errors: leave
 *     the store alone; the next refresh's grace logic handles outages.
 *   - Successful 200: clear any grace marker, fire onSuccess.
 *
 * Returns `true` on success, `false` on any handled error (so the
 * synchronous wrapper can surface a boolean to small CLIs).
 */
async function tickOnce(opts: HeartbeatOptions, path: string): Promise<boolean> {
  const stateBefore = await opts.store.read();
  if (stateBefore.token === null) {
    // No token to heartbeat with. Skip silently — application hasn't
    // activated yet.
    return true;
  }
  try {
    await postJson<HeartbeatResponseData>(path, { token: stateBefore.token }, opts);
    // Success — clear any grace marker. CAS guard against a parallel
    // refresh that wrote a fresh token.
    const stateAfter = await opts.store.read();
    if (stateAfter.token === stateBefore.token && stateAfter.graceStartSec !== null) {
      await opts.store.write({ token: stateAfter.token, graceStartSec: null });
    }
    opts.onSuccess?.();
    return true;
  } catch (err) {
    if (
      err instanceof LicensingClientError &&
      (err.code === 'LicenseRevoked' || err.code === 'LicenseSuspended')
    ) {
      // CAS clear: only blow away the store if the token we just got
      // rejected is still the one persisted. A parallel refresh that
      // already swapped in a fresh token must not be clobbered.
      const stateNow = await opts.store.read();
      if (stateNow.token === stateBefore.token) {
        await opts.store.clear();
      }
    }
    const error = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(error);
    return false;
  }
}

// Re-export helpers that pair well with heartbeat usage.
export { clientErrors };
