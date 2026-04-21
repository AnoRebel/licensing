import { getHeader, getMethod, getQuery, readRawBody, sendWebResponse } from 'h3';

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
export default defineEventHandler(async (event) => {
  const { upstreamBaseUrl } = useRuntimeConfig(event);
  if (!upstreamBaseUrl) {
    throw createError({ statusCode: 500, statusMessage: 'upstream not configured' });
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

  const method = getMethod(event);
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
