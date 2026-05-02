/**
 * Framework-agnostic licence-guard core.
 *
 * Each framework adapter (Express / Hono / Fastify) is a thin shim over
 * this module: extract a fingerprint from the framework's native request
 * shape, call `runGuard`, and translate the result into the framework's
 * native response. The error JSON shape and status-code mapping live
 * here — that's how the "error response identical across frameworks"
 * property is enforced. Drift would require touching this file, which
 * means it'd show up in code review.
 *
 * The middleware is **stateless**: `runGuard` doesn't touch a database
 * directly; it delegates to the caller-supplied `Client` instance which
 * owns its token store and verify config. Concurrency safety is the
 * Client's responsibility (and the existing Client implementation is
 * already concurrent-safe via its async store interface).
 */

import { LicensingClientError } from '../client/index.ts';
import type { Client, LicenseHandle } from '../easy.ts';

/** Caller-supplied fingerprint extractor. Receives the framework's
 *  native request and returns the device fingerprint string the token
 *  was bound to. Returning a Promise is supported so async resolvers
 *  (e.g. fetching from a session store) work without ceremony.
 *
 *  When the extractor throws or returns null/undefined/empty string,
 *  the middleware surfaces a 400 `MissingFingerprint` error before
 *  consulting the Client. */
export type FingerprintExtractor<Req> = (
  req: Req,
) => string | null | undefined | Promise<string | null | undefined>;

/** Optional callback fired when the guard succeeds. Useful for logging
 *  or for populating framework-specific request context that this core
 *  doesn't know about (e.g. Hono's `c.set`). */
export type OnSuccessHook<Req> = (req: Req, handle: LicenseHandle) => void | Promise<void>;

/** Shape of the JSON body returned on guard failure. Stable across all
 *  framework adapters by design; do NOT add framework-specific fields
 *  here without updating the cross-framework contract test. */
export interface GuardErrorBody {
  /** Stable machine-readable code from `LicensingClientError.code`, or
   *  `'MissingFingerprint'` / `'InternalError'` for the two cases that
   *  don't originate from the client. */
  readonly error: string;
  /** Human-readable message suitable for logs. SHOULD NOT be displayed
   *  to end users without translation. */
  readonly message: string;
}

/** Result of `runGuard`. Either the licence handle (`ok: true`) or an
 *  HTTP-shaped error response (`ok: false`). Adapters translate the
 *  error case into framework-native responses. */
export type GuardResult =
  | { readonly ok: true; readonly handle: LicenseHandle }
  | { readonly ok: false; readonly status: number; readonly body: GuardErrorBody };

/** Common configuration shared by every framework adapter. Each adapter
 *  layers its own framework-specific options on top. */
export interface LicenseGuardOptions<Req> {
  /** Pre-constructed `Licensing.client(...)` (or `Client` instance from
   *  the primitive layer). The middleware does NOT construct one for
   *  you because that would force a particular storage decision. */
  readonly client: Client;
  /** How to pull the device fingerprint out of the request. Common
   *  shapes:
   *    - `(req) => req.headers['x-fingerprint']`
   *    - `(req) => req.cookies?.fingerprint`
   *    - `(req) => fingerprintFromSession(req.session)`
   *  No default — the middleware can't guess where you stored it. */
  readonly fingerprint: FingerprintExtractor<Req>;
  /** Optional hook fired on successful guard. Adapters may also
   *  populate their own request-context attachment in their wrapping
   *  code (e.g. `req.license = handle`); this hook is for additional
   *  side effects. */
  readonly onSuccess?: OnSuccessHook<Req>;
}

/** Map a client error code to an HTTP status. Fingerprint mismatch and
 *  audience/issuer mismatches are 403 (policy block); token expiry and
 *  not-yet-valid are 401 (auth); replay is 401; revoked/suspended are
 *  403; rate-limited is 429; transport problems are 502 / 503. Anything
 *  unmapped falls through to 500 — these are caller bugs we surface
 *  rather than swallow.
 *
 *  This table is the authoritative source of HTTP semantics: every framework
 *  adapter MUST run errors through this map and emit the resulting
 *  status. Drift would mean a multi-framework consumer sees different
 *  HTTP semantics depending on which adapter they happen to be using
 *  this minute. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // 400 — caller didn't supply what we need
  MissingFingerprint: 400,
  InvalidTokenFormat: 400,
  // 401 — auth (token-level)
  NoToken: 401,
  TokenExpired: 401,
  TokenNotYetValid: 401,
  TokenReplayed: 401,
  // 403 — policy / lifecycle block
  FingerprintMismatch: 403,
  AudienceMismatch: 403,
  IssuerMismatch: 403,
  LicenseRevoked: 403,
  LicenseSuspended: 403,
  GraceExpired: 403,
  RequiresOnlineRefresh: 403,
  // 404 — bad license / unknown key
  InvalidLicenseKey: 404,
  UnknownKid: 404,
  // 422 — caller wired the verifier wrong
  UnsupportedAlgorithm: 422,
  AlgorithmMismatch: 422,
  // 429 — rate limit
  RateLimited: 429,
  // 502 — issuer protocol problem (response shape unexpected)
  IssuerProtocolError: 502,
  // 503 — transport
  IssuerUnreachable: 503,
};

/** Translate a thrown value from `client.guard` into a `GuardResult`.
 *  Exported for the test matrix; framework adapters call `runGuard`
 *  rather than this directly. */
export function buildGuardError(err: unknown): { status: number; body: GuardErrorBody } {
  if (err instanceof LicensingClientError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    return {
      status,
      body: { error: err.code, message: err.message },
    };
  }
  // Non-LicensingClientError throws are caller bugs (or framework bugs).
  // Surface as 500 with a stable code so log aggregators can alert on
  // these specifically.
  return {
    status: 500,
    body: {
      error: 'InternalError',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * Run the licence guard against `req`. Caller-supplied
 * `fingerprintExtractor` resolves the device fingerprint; the result is
 * either the handle (success) or a structured error suitable for
 * framework adapters to serialize.
 *
 * Adapters MUST translate the error case faithfully — same status, same
 * body, same JSON encoding (no framework-specific envelope). This is
 * what makes the "identical across frameworks" guarantee hold.
 */
export async function runGuard<Req>(
  req: Req,
  opts: LicenseGuardOptions<Req>,
): Promise<GuardResult> {
  let fingerprint: string | null | undefined;
  try {
    fingerprint = await opts.fingerprint(req);
  } catch (err) {
    // Extractor failed — treat as "missing fingerprint" rather than
    // 500; the user's request is malformed, not the server.
    return {
      ok: false,
      status: 400,
      body: {
        error: 'MissingFingerprint',
        message: `fingerprint extractor threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'MissingFingerprint',
        message: 'fingerprint extractor returned no value',
      },
    };
  }

  let handle: LicenseHandle;
  try {
    handle = await opts.client.guard({ fingerprint });
  } catch (err) {
    const { status, body } = buildGuardError(err);
    return { ok: false, status, body };
  }

  if (opts.onSuccess !== undefined) {
    try {
      await opts.onSuccess(req, handle);
    } catch (err) {
      // onSuccess hook errors are surfaced as 500 — the guard succeeded
      // logically, but the caller's hook policy failed; we can't safely
      // proceed without that side effect (it might be authorization
      // middleware, audit logging, etc.).
      const { status, body } = buildGuardError(err);
      return { ok: false, status, body };
    }
  }

  return { ok: true, handle };
}
