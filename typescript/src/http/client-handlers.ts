/**
 * Client-facing handlers.
 *
 * Five endpoints per `openapi/licensing-admin.yaml`:
 *
 *   GET  /health      — liveness + build info (public)
 *   POST /activate    — license-key → signed LIC1 token (public)
 *   POST /refresh     — swap a valid token for a fresher one (public)
 *   POST /heartbeat   — periodic liveness; MAY rotate token (public)
 *   POST /deactivate  — release a seat by token (public, body-authenticated)
 *
 * Every path is registered as `public: true` so the bearer-auth middleware
 * skips them. Authentication on client endpoints is body-derived (license
 * key, signed token) rather than header-derived (admin bearer).
 */

import {
  decodeUnverified,
  findLicenseByKey,
  issueToken,
  LicensingError,
  registerUsage,
  revokeUsage,
} from '../index.ts';
import type { ClientHandlerContext } from './context.ts';
import { err, errFromLicensing, noContent, ok } from './envelope.ts';
import type { Route } from './router.ts';
import type { HandlerRequest, HandlerResponse, JsonValue } from './types.ts';
import {
  optionalObject,
  requireFingerprint,
  requireJsonObject,
  requireString,
} from './validation.ts';

// Core does not export `unixSeconds`; inline the 5-line equivalent. Kept
// strict: any malformed ISO-8601 returns NaN, which callers MUST guard
// against (we only use this after a successful `clock.nowIso()` so it's safe).
function unixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function isoOf(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

async function handleHealth(ctx: ClientHandlerContext): Promise<HandlerResponse> {
  return ok({ status: 'ok', version: ctx.version });
}

async function handleActivate(
  ctx: ClientHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const licenseKey = requireString(body.value, 'license_key');
  if (!licenseKey.ok) return licenseKey.response;
  const fingerprint = requireFingerprint(body.value);
  if (!fingerprint.ok) return fingerprint.response;
  const clientMeta = optionalObject(body.value, 'client_meta');
  if (!clientMeta.ok) return clientMeta.response;

  try {
    const license = await findLicenseByKey(ctx.storage, licenseKey.value);
    if (license === null) {
      // "Activate with invalid key returns 404" — explicit code.
      return err(404, 'InvalidLicenseKey', 'license key is invalid or unknown');
    }
    // Register the usage (idempotent on fingerprint); possibly promotes
    // the license `pending → active`.
    const reg = await registerUsage(ctx.storage, ctx.clock, {
      license_id: license.id,
      fingerprint: fingerprint.value,
      ...(clientMeta.value !== null ? { client_meta: clientMeta.value } : {}),
    });
    const alg = ctx.defaultAlg ?? 'ed25519';
    const ttl = ctx.tokenTtlSec ?? 3600;
    const issued = await issueToken(ctx.storage, ctx.clock, ctx.backends, {
      license: reg.license,
      usage: reg.usage,
      ttlSeconds: ttl,
      alg,
      signingPassphrase: ctx.signingPassphrase,
      ...(ctx.forceOnlineAfter !== undefined ? { forceOnlineAfter: ctx.forceOnlineAfter } : {}),
    });
    // `refresh_recommended_at` is the 75%-of-lifetime mark: clients
    // proactively refresh when less than 25% remains.
    const refreshAt = issued.iat + Math.floor(ttl * 0.75);
    const body: Record<string, JsonValue> = {
      token: issued.token,
      expires_at: isoOf(issued.exp),
      refresh_recommended_at: isoOf(refreshAt),
    };
    // OpenAPI allows explicit null for force_online_after; surface it so
    // clients can surface a deterministic hard deadline when present.
    const parts = decodeUnverified(issued.token);
    const foa = parts.payload.force_online_after;
    if (typeof foa === 'number') {
      body.force_online_after = isoOf(foa);
    }
    return ok(body);
  } catch (e) {
    return errFromLicensing(e);
  }
}

/** Refresh + heartbeat share the bulk of their work: decode the (unverified)
 *  token, re-resolve the license/usage, re-issue. The difference is the
 *  response envelope.
 *
 *  Verification-on-refresh note: the issuer does NOT re-verify the
 *  incoming token's signature on refresh — a client that holds a token
 *  is already trusted to the extent of its seat, and any tampering will
 *  fail `validate()` on the next client-side check anyway.
 *  We DO re-resolve the license by claim and re-check status, so a revoked
 *  license cannot refresh even with a valid old token. */
async function reissueFromToken(
  ctx: ClientHandlerContext,
  token: string,
): Promise<
  | { readonly token: string; readonly expiresAt: string; readonly foa: string | null }
  | HandlerResponse
> {
  let parts: ReturnType<typeof decodeUnverified>;
  try {
    parts = decodeUnverified(token);
  } catch (e) {
    return errFromLicensing(e);
  }
  const licenseId = parts.payload.license_id;
  const usageId = parts.payload.usage_id;
  if (typeof licenseId !== 'string' || typeof usageId !== 'string') {
    return err(401, 'TokenMalformed', 'token missing required claims');
  }

  const license = await ctx.storage.getLicense(licenseId);
  if (license === null) return err(404, 'LicenseNotFound', `license not found: ${licenseId}`);
  const usage = await ctx.storage.getUsage(usageId);
  if (usage === null) return err(404, 'NotFound', `usage not found: ${usageId}`);
  if (usage.license_id !== license.id) {
    return err(401, 'TokenMalformed', 'token usage does not belong to token license');
  }
  if (usage.status !== 'active') {
    return err(403, 'LicenseRevoked', `usage ${usage.id} is no longer active`);
  }

  const alg = ctx.defaultAlg ?? 'ed25519';
  const ttl = ctx.tokenTtlSec ?? 3600;
  const issued = await issueToken(ctx.storage, ctx.clock, ctx.backends, {
    license,
    usage,
    ttlSeconds: ttl,
    alg,
    signingPassphrase: ctx.signingPassphrase,
    ...(ctx.forceOnlineAfter !== undefined ? { forceOnlineAfter: ctx.forceOnlineAfter } : {}),
  });
  const decoded = decodeUnverified(issued.token);
  const foa = decoded.payload.force_online_after;
  return {
    token: issued.token,
    expiresAt: isoOf(issued.exp),
    foa: typeof foa === 'number' ? isoOf(foa) : null,
  };
}

async function handleRefresh(
  ctx: ClientHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const token = requireString(body.value, 'token');
  if (!token.ok) return token.response;

  try {
    const result = await reissueFromToken(ctx, token.value);
    if ('status' in result) return result; // already an error response
    const ttl = ctx.tokenTtlSec ?? 3600;
    const nowSec = unixSeconds(ctx.clock.nowIso());
    const refreshAt = nowSec + Math.floor(ttl * 0.75);
    const out: Record<string, JsonValue> = {
      token: result.token,
      expires_at: result.expiresAt,
      refresh_recommended_at: isoOf(refreshAt),
    };
    if (result.foa !== null) out.force_online_after = result.foa;
    return ok(out);
  } catch (e) {
    if (e instanceof LicensingError) return errFromLicensing(e);
    return err(500, 'InternalError', 'an unexpected error occurred');
  }
}

async function handleHeartbeat(
  ctx: ClientHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const token = requireString(body.value, 'token');
  if (!token.ok) return token.response;

  // Policy: heartbeat returns `{ok:true}` without rotating by default.
  // Opportunistic rotation is allowed — wiring the policy hook lives
  // in future work; for now we never rotate on heartbeat.
  try {
    // Re-resolve license/usage so revoked states surface as 403 even here.
    let parts: ReturnType<typeof decodeUnverified>;
    try {
      parts = decodeUnverified(token.value);
    } catch (e) {
      return errFromLicensing(e);
    }
    const licenseId = parts.payload.license_id;
    const usageId = parts.payload.usage_id;
    if (typeof licenseId !== 'string' || typeof usageId !== 'string') {
      return err(401, 'TokenMalformed', 'token missing required claims');
    }
    const license = await ctx.storage.getLicense(licenseId);
    if (license === null) return err(404, 'LicenseNotFound', `license not found: ${licenseId}`);
    if (license.status === 'revoked') return err(403, 'LicenseRevoked', 'license is revoked');
    if (license.status === 'suspended') return err(403, 'LicenseSuspended', 'license is suspended');
    const usage = await ctx.storage.getUsage(usageId);
    if (usage === null || usage.status !== 'active') {
      return err(403, 'LicenseRevoked', `usage ${usageId} is no longer active`);
    }
    return ok({
      ok: true,
      server_time: ctx.clock.nowIso(),
    });
  } catch (e) {
    return errFromLicensing(e);
  }
}

async function handleDeactivate(
  ctx: ClientHandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const body = requireJsonObject(req);
  if (!body.ok) return body.response;
  const token = requireString(body.value, 'token');
  if (!token.ok) return token.response;
  const reason = requireString(body.value, 'reason');
  if (!reason.ok) return reason.response;
  if (!['user_requested', 'uninstall', 'reassign', 'other'].includes(reason.value)) {
    return err(400, 'BadRequest', `invalid reason: ${reason.value}`);
  }

  try {
    let parts: ReturnType<typeof decodeUnverified>;
    try {
      parts = decodeUnverified(token.value);
    } catch (e) {
      return errFromLicensing(e);
    }
    const usageId = parts.payload.usage_id;
    if (typeof usageId !== 'string') {
      return err(401, 'TokenMalformed', 'token missing usage_id');
    }
    const usage = await ctx.storage.getUsage(usageId);
    if (usage === null) return err(404, 'NotFound', `usage not found: ${usageId}`);
    // Idempotent — already-revoked usages still return 204.
    if (usage.status !== 'revoked') {
      await revokeUsage(ctx.storage, ctx.clock, usageId, { actor: `client:${reason.value}` });
    }
    return noContent();
  } catch (e) {
    return errFromLicensing(e);
  }
}

/** Build the client-facing route set. Prefix is added by the caller when
 *  mounting the handler group (typical: `/api/licensing/v1`). */
export function clientRoutes(ctx: ClientHandlerContext, prefix = ''): readonly Route[] {
  const p = (path: string) => `${prefix}${path}`;
  return [
    { method: 'GET', pattern: p('/health'), handler: () => handleHealth(ctx), public: true },
    {
      method: 'POST',
      pattern: p('/activate'),
      handler: (req) => handleActivate(ctx, req),
      public: true,
    },
    {
      method: 'POST',
      pattern: p('/refresh'),
      handler: (req) => handleRefresh(ctx, req),
      public: true,
    },
    {
      method: 'POST',
      pattern: p('/heartbeat'),
      handler: (req) => handleHeartbeat(ctx, req),
      public: true,
    },
    {
      method: 'POST',
      pattern: p('/deactivate'),
      handler: (req) => handleDeactivate(ctx, req),
      public: true,
    },
  ];
}
