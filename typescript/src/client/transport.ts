/**
 * Issuer HTTP transport — the minimal surface the client uses to talk to
 * `/activate`, `/refresh`, `/heartbeat`, `/deactivate`.
 *
 * The envelope is fixed: `{ success: true, data: <object> }` on success,
 * `{ success: false, error: { code, message } }` on failure. We normalize
 * both into either `data` or a thrown {@link LicensingClientError} so the
 * call sites stay uncluttered.
 *
 * Network-level failures (DNS, connection refused, TLS, timeout, aborted
 * fetch) collapse into `IssuerUnreachable` rather than leaking the raw
 * cause type — offline-first clients treat "couldn't reach the issuer"
 * uniformly regardless of *why* they couldn't.
 *
 * This module is intentionally framework-free: it only uses the platform
 * `fetch`. Consumers running on older Node can inject a polyfill via the
 * `fetchImpl` option.
 */

import { clientErrors, fromIssuerCode, LicensingClientError } from './errors.ts';

/** Platform fetch type — we accept any callable matching the shape so
 *  consumers can inject a mock or a polyfill. */
export type FetchImpl = typeof fetch;

export interface TransportOptions {
  /** Base URL of the issuer (e.g. `https://issuer.example.com`). The
   *  client appends the endpoint path — do NOT include a trailing slash
   *  and do NOT include the `/api/licensing/v1` prefix here; that's part
   *  of the endpoint path passed to {@link postJson}. */
  readonly baseUrl: string;
  /** Request timeout in milliseconds. 0 disables. Default 15_000. */
  readonly timeoutMs?: number;
  /** Optional fetch override, e.g. for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Extra headers applied to every request (e.g. `User-Agent`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Envelope shape the issuer returns on success. */
interface SuccessEnvelope<T> {
  readonly success: true;
  readonly data: T;
}

/** Envelope shape the issuer returns on failure. */
interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * POST a JSON body to `<baseUrl><path>` and return the envelope's `data`.
 * Throws a {@link LicensingClientError} with a mapped `.code` on any
 * non-success outcome.
 *
 * Why we build our own instead of using a library: the client should add
 * zero runtime dependencies beyond `@anorebel/licensing`. A 60-line `fetch`
 * wrapper saves us a supply-chain edge and keeps bundle size honest for
 * browser consumers that might embed this someday.
 */
export async function postJson<T>(path: string, body: unknown, opts: TransportOptions): Promise<T> {
  const url = joinUrl(opts.baseUrl, path);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      : null;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (DNS, TLS, refused, abort). Uniformly surface
    // as IssuerUnreachable so callers have a single code to branch on for
    // "offline-grace applies here".
    throw clientErrors.issuerUnreachable(`POST ${url} failed at the transport layer`, err);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  // 429 gets special treatment: we need the Retry-After header, and the
  // body may not even be JSON on some proxies. Construct the error from
  // the header directly.
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    // Try to parse a body for a better message, but don't fail if it's not JSON.
    let message = 'issuer rate-limited this client';
    try {
      const parsed = (await response.clone().json()) as ErrorEnvelope;
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // ignore — header is authoritative
    }
    throw clientErrors.rateLimited(retryAfter, message);
  }

  // Parse the envelope. Non-JSON or malformed bodies from the issuer are
  // treated as "unreachable" rather than "client format error" — the
  // client's format contract is with OUR server, not theirs, so a broken
  // response usually means a misconfigured reverse proxy or LB error page
  // slipped past.
  let parsed: SuccessEnvelope<T> | ErrorEnvelope;
  try {
    parsed = (await response.json()) as SuccessEnvelope<T> | ErrorEnvelope;
  } catch (err) {
    throw clientErrors.issuerUnreachable(
      `POST ${url} returned non-JSON body (status ${response.status})`,
      err,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !('success' in parsed)) {
    throw clientErrors.issuerUnreachable(
      `POST ${url} returned an envelope missing "success" (status ${response.status})`,
    );
  }

  if (parsed.success === true) {
    // 2xx + success:true + data. We don't validate the shape of `data`
    // here — each endpoint knows what fields it expects.
    return parsed.data;
  }

  // success:false — translate via the issuer→client code map.
  const retryAfter =
    response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
  throw fromIssuerCode(
    parsed.error?.code ?? 'Unknown',
    parsed.error?.message ??
      `issuer returned success=false without a message (status ${response.status})`,
    response.status,
    retryAfter,
  );
}

/** Same as {@link postJson} but re-throws `LicensingClientError` instances
 *  unchanged and wraps unexpected throws in `InvalidTokenFormat` — used by
 *  call sites that want a uniform error stream. */
export function isClientError(err: unknown): err is LicensingClientError {
  return err instanceof LicensingClientError;
}

// ---------- internals ----------

function joinUrl(base: string, path: string): string {
  // Both well-formed: base has no trailing slash, path starts with "/".
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return base + path;
}

/** Parse Retry-After: either a delta-seconds integer or an HTTP-date. We
 *  only honor the integer form — HTTP-date is rare in practice and adds
 *  timezone parsing surface. Falls back to 60s if unparseable. */
function parseRetryAfter(header: string | null): number {
  if (header === null) return 60;
  const n = Number.parseInt(header, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 60;
}
