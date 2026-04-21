import {
  getHeader,
  getMethod,
  getQuery,
  getRequestHost,
  getRequestProtocol,
  readRawBody,
  sendWebResponse,
} from 'h3';

/**
 * Catch-all proxy for every licensing API call the browser makes.
 *
 * The browser never sees the upstream URL or the bearer token — it only
 * calls `/api/proxy/*`. This handler reads `secure.apiToken` from the
 * sealed cookie session (via nuxt-auth-utils), rewrites the path at the
 * edge, and forwards with `Authorization: Bearer ...`.
 *
 * Why a catch-all and not per-route handlers:
 *   - nuxt-open-fetch generates 31 typed composables. Hand-mirroring each
 *     as a server route doubles the surface area and guarantees drift.
 *   - Auth is uniform (bearer on every admin endpoint), rate limiting is
 *     handled upstream, and response shape is already typed on the client
 *     side — there is nothing this layer should do except forward.
 *
 * What this layer MUST NOT do:
 *   - Parse or rewrite the response body (types are maintained upstream)
 *   - Log the Authorization header (stderr redaction is belt-and-braces)
 *   - Accept client-supplied Authorization headers (the bearer is ours
 *     to set, period — an attacker-controlled header would bypass the
 *     httpOnly cookie that is the whole reason we proxy in the first
 *     place).
 */

// Methods we refuse to forward unless we can prove the request came from
// the admin UI itself. GET / HEAD / OPTIONS are idempotent and the upstream
// mutates nothing on their behalf — still require a same-origin hint where
// modern browsers send one (Sec-Fetch-Site), but don't fail the request if
// it's absent (old browsers, non-fetch clients, health probes).
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Sec-Fetch-Site values we trust. `none` is the user typing a URL directly
// into the address bar — that's not an attacker-controlled context. Any
// cross-site or same-site-but-different-origin value is rejected for
// state-changing verbs.
const SEC_FETCH_SITE_ALLOWED = new Set(['same-origin', 'none']);

export default defineEventHandler(async (event) => {
  const { upstreamBaseUrl } = useRuntimeConfig(event);
  if (!upstreamBaseUrl) {
    throw createError({ statusCode: 500, statusMessage: 'upstream not configured' });
  }

  const method = getMethod(event);

  // CSRF defence-in-depth. The session cookie is already `sameSite=strict`
  // (nuxt.config.ts), which by itself defeats every CSRF vector modern
  // browsers can launch. We additionally verify Origin / Sec-Fetch-Site
  // here because:
  //   1. SameSite is a browser policy — if a buggy browser or a mis-tuned
  //      CDN strips the attribute, the cookie reverts to the old
  //      attacker-favouring default.
  //   2. This layer also fronts programmatic callers one day (CLI, CI).
  //      Explicit origin policy is cheaper to reason about than implicit
  //      cookie policy.
  // For state-changing methods we REQUIRE a proof of same-origin provenance:
  //   - Sec-Fetch-Site === 'same-origin' (browser-enforced, unforgeable
  //     via fetch), OR
  //   - Origin header matches this server's own origin.
  // Missing both → 403.
  if (STATE_CHANGING.has(method)) {
    const secFetchSite = getHeader(event, 'sec-fetch-site');
    const origin = getHeader(event, 'origin');
    const host = getRequestHost(event, { xForwardedHost: false });
    const proto = getRequestProtocol(event, { xForwardedProto: false });
    const selfOrigin = `${proto}://${host}`;

    const secFetchOK = secFetchSite !== undefined && SEC_FETCH_SITE_ALLOWED.has(secFetchSite);
    const originOK = origin !== undefined && origin === selfOrigin;

    if (!secFetchOK && !originOK) {
      throw createError({
        statusCode: 403,
        statusMessage: 'cross-origin request refused',
      });
    }
  }

  // requireUserSession throws 401 if no session — client sees it and can
  // redirect to /sign-in (wired at 13.3).
  const { secure } = await requireUserSession(event);
  const apiToken = secure?.apiToken;
  if (!apiToken) {
    throw createError({ statusCode: 401, statusMessage: 'missing api token in session' });
  }

  // `event.context.params._` is the wildcard capture, e.g. for
  // `/api/proxy/admin/licenses/123` → "admin/licenses/123".
  const upstreamPath = (event.context.params?._ ?? '').replace(/^\/+/, '');
  const url = new URL(`${upstreamBaseUrl.replace(/\/+$/, '')}/${upstreamPath}`);
  const query = getQuery(event);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  const contentType = getHeader(event, 'content-type');
  const accept = getHeader(event, 'accept') ?? 'application/json';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(event);

  const upstream = await fetch(url.toString(), {
    method,
    headers: {
      // Deliberately a small allowlist — never forward browser-set
      // Authorization, Cookie, or X-Forwarded-* headers.
      accept,
      ...(contentType ? { 'content-type': contentType } : {}),
      authorization: `Bearer ${apiToken}`,
    },
    body,
    redirect: 'manual',
  });

  // Hand the upstream Response back to h3 verbatim — preserves status,
  // headers, and streams the body without us having to mirror each piece
  // manually.
  return sendWebResponse(event, upstream);
});
