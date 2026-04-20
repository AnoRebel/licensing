/**
 * Bearer-token authentication middleware.
 *
 * All admin endpoints require `Authorization: Bearer <token>` and return
 * 401 when the header is absent or invalid.
 *
 * Design:
 *   - The verifier is pluggable. The default is a constant-time
 *     shared-secret compare, sufficient for dev and sane production when
 *     paired with rotation; more complex schemes (JWT/OIDC verification,
 *     mTLS-derived identity) plug in by swapping the verifier.
 *   - Public routes short-circuit via the synthetic `x-licensing-route-public`
 *     header the router attaches. That keeps the middleware declarative
 *     — it doesn't need a route table.
 *   - We intentionally do NOT read the `Authorization` header's value into
 *     the response body on failure. Echoing caller-supplied secrets back
 *     is a classic misconfiguration.
 */

import { timingSafeEqual } from 'node:crypto';
import { err } from './envelope.ts';
import type { HandlerRequest, Middleware } from './types.ts';

/** Async verifier contract. Return `null` to reject (401 follows), or an
 *  identity object callers can read. Thrown errors become 401 too — we
 *  don't leak internal details. */
export type BearerVerifier = (token: string) => Promise<AuthIdentity | null>;

/** Opaque identity handed to downstream handlers. `subject` is the only
 *  guaranteed field — the rest is verifier-specific. */
export interface AuthIdentity {
  readonly subject: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface BearerAuthOptions {
  readonly verify: BearerVerifier;
}

/** Constant-time secret comparison. Returns a verifier that accepts `token`
 *  equal to `secret` and rejects everything else. For dev + simple prod. */
export function sharedSecretVerifier(secret: string): BearerVerifier {
  if (secret.length === 0) {
    throw new Error('sharedSecretVerifier: secret must be non-empty');
  }
  const expected = Buffer.from(secret, 'utf8');
  return async (token) => {
    const got = Buffer.from(token, 'utf8');
    // Different lengths → constant-time-equal returns false without a throw,
    // but node's API throws on mismatched lengths. Guard explicitly.
    if (got.length !== expected.length) return null;
    return timingSafeEqual(got, expected) ? { subject: 'shared-secret' } : null;
  };
}

/** Extract a bearer token from the Authorization header. Returns `null`
 *  when the header is absent, malformed, or uses a different scheme. */
export function parseBearer(req: HandlerRequest): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const trimmed = header.trim();
  // Case-insensitive scheme match per RFC 7235.
  if (trimmed.length < 7) return null;
  if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** Build an auth middleware. Public routes (flagged via
 *  `x-licensing-route-public`) pass through without invoking the verifier. */
export function bearerAuth(opts: BearerAuthOptions): Middleware {
  return async (req, next) => {
    if (req.headers['x-licensing-route-public'] === '1') {
      return next(req);
    }
    const token = parseBearer(req);
    if (token === null) {
      return err(401, 'Unauthenticated', 'missing or malformed Authorization header');
    }
    let identity: AuthIdentity | null;
    try {
      identity = await opts.verify(token);
    } catch {
      return err(401, 'Unauthenticated', 'credential verification failed');
    }
    if (identity === null) {
      return err(401, 'Unauthenticated', 'invalid credentials');
    }
    // Downstream handlers that care read the identity from a synthetic
    // header. We stringify `subject` only; callers needing richer claims
    // should use the verifier's return value via a closure instead of
    // threading through the request shape.
    const enriched: HandlerRequest = {
      ...req,
      headers: { ...req.headers, 'x-licensing-auth-subject': identity.subject },
    };
    return next(enriched);
  };
}
