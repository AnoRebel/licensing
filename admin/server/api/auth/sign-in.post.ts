import * as v from 'valibot';
import { SignInSchema } from '../../../shared/schemas/auth';

/**
 * Exchange a bearer token for a sealed admin session.
 *
 * Why we probe upstream before sealing:
 *   - The UI is auth-agnostic (see licensing-admin-ui spec). An operator
 *     pastes whatever bearer their issuer issued — API key, PAT, OIDC
 *     access token, doesn't matter. The only validation we can do is
 *     "does the upstream accept it?"
 *   - A bad token sealed into the cookie would surface later as a 401
 *     on the first real API call, which the client plugin would then
 *     bounce back to /sign-in → infinite loop. Probe here, fail here.
 *
 * Probe target: GET /admin/licenses?limit=1. Cheap, authenticated, and
 * part of the stable admin surface — if the bearer can't list licenses,
 * it can't drive anything else in this UI either.
 */
export default defineEventHandler(async (event) => {
  const { upstreamBaseUrl } = useRuntimeConfig(event);

  const raw = await readBody(event);
  const parsed = v.safeParse(SignInSchema, raw);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid request',
      data: {
        error: {
          code: 'InvalidRequest',
          message: parsed.issues[0]?.message ?? 'Invalid sign-in payload.',
        },
      },
    });
  }

  const { token } = parsed.output;

  let probe: Response;
  try {
    probe = await fetch(`${upstreamBaseUrl.replace(/\/+$/, '')}/admin/licenses?limit=1`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch {
    // ECONNREFUSED, DNS failure, TLS handshake, etc — anything that
    // prevents a response from existing at all. Surface as 502 so the UI
    // blames the upstream, not the operator's token.
    throw createError({
      statusCode: 502,
      statusMessage: 'upstream unavailable',
      data: {
        error: {
          code: 'UpstreamUnavailable',
          message:
            'Could not reach the licensing API. Check that the upstream is running and that LICENSING_UPSTREAM_BASE_URL points at it.',
        },
      },
    });
  }

  if (probe.status === 401 || probe.status === 403) {
    throw createError({
      statusCode: 401,
      statusMessage: 'invalid token',
      data: { error: { code: 'InvalidToken', message: 'Upstream rejected the provided token.' } },
    });
  }

  if (!probe.ok) {
    // Upstream reachable but returned 4xx/5xx other than auth — almost
    // always a server-side problem we can't fix from the UI.
    throw createError({
      statusCode: 502,
      statusMessage: 'upstream unavailable',
      data: {
        error: { code: 'UpstreamUnavailable', message: `Upstream responded ${probe.status}.` },
      },
    });
  }

  await setUserSession(event, {
    user: { id: 'operator', email: 'operator@local' },
    loggedInAt: Date.now(),
    secure: { apiToken: token },
  });

  return { ok: true };
});
