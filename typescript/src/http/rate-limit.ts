/**
 * Rate-limit middleware.
 *
 * Client-facing endpoints implement rate limiting. When a client exceeds
 * the configured rate the response is HTTP 429 with
 * `error.code = "RateLimited"` and a `Retry-After` header in seconds.
 *
 * Implementation:
 *   - Token-bucket per keying function. Default key is `remoteAddr`.
 *   - In-memory bucket store. Adequate for single-instance dev; production
 *     deployments should plug in a shared store (Redis, etc.) via the
 *     `BucketStore` interface.
 *   - `Retry-After` is computed from the time until one token refills,
 *     expressed as integer seconds (RFC 9110 §10.2.3 integer form —
 *     matches the client's parser in `@anorebel/licensing/client`).
 */

import { err } from './envelope.ts';
import type { HandlerRequest, Middleware } from './types.ts';

/** A single bucket's persistent state. `tokens` is a float because partial
 *  refills happen between requests. */
export interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Pluggable bucket persistence. Sync because the default (in-memory Map)
 *  is sync; async stores should wrap themselves in a sync-looking facade
 *  or use `Promise.resolve` — the middleware awaits either way. */
export interface BucketStore {
  get(key: string): Bucket | undefined | Promise<Bucket | undefined>;
  set(key: string, bucket: Bucket): void | Promise<void>;
}

/** Default in-memory store. Lives for the process lifetime; if memory
 *  growth matters, pair with a TTL-based map or plug in your own store. */
export class MemoryBucketStore implements BucketStore {
  private readonly buckets = new Map<string, Bucket>();
  get(key: string): Bucket | undefined {
    return this.buckets.get(key);
  }
  set(key: string, bucket: Bucket): void {
    this.buckets.set(key, bucket);
  }
  /** Test-only: clear the store. */
  clear(): void {
    this.buckets.clear();
  }
}

export interface RateLimitOptions {
  /** Burst capacity — the maximum tokens a single key can hold. */
  readonly burst: number;
  /** Long-run refill rate in tokens per second. */
  readonly refillPerSec: number;
  /** Key derivation. Default: `req.remoteAddr`. */
  readonly keyFn?: (req: HandlerRequest) => string;
  /** When true, public routes (flagged `x-licensing-route-public`) are
   *  skipped. Default false — client-facing routes ARE public from the
   *  auth middleware's perspective but MUST be rate-limited. */
  readonly skipPublic?: boolean;
  /** Store. Default: new in-memory store. */
  readonly store?: BucketStore;
  /** Clock injection for tests. Default `Date.now`. */
  readonly now?: () => number;
}

function defaultKey(req: HandlerRequest): string {
  return req.remoteAddr;
}

/** Build a rate-limit middleware. Denies with 429 + `Retry-After` on
 *  bucket exhaustion. */
export function rateLimit(opts: RateLimitOptions): Middleware {
  if (opts.burst <= 0) throw new Error('rateLimit: burst must be > 0');
  if (opts.refillPerSec <= 0) throw new Error('rateLimit: refillPerSec must be > 0');
  const store = opts.store ?? new MemoryBucketStore();
  const now = opts.now ?? (() => Date.now());
  const keyFn = opts.keyFn ?? defaultKey;
  const skipPublic = opts.skipPublic ?? false;

  return async (req, next) => {
    if (skipPublic && req.headers['x-licensing-route-public'] === '1') {
      return next(req);
    }
    const key = keyFn(req);
    const nowMs = now();
    const existing = await store.get(key);
    const prev: Bucket = existing ?? { tokens: opts.burst, lastRefillMs: nowMs };
    // Refill based on elapsed time, capped at burst capacity.
    const elapsedSec = Math.max(0, (nowMs - prev.lastRefillMs) / 1000);
    const refilled = Math.min(opts.burst, prev.tokens + elapsedSec * opts.refillPerSec);
    if (refilled < 1) {
      // Not enough tokens. Compute seconds until one becomes available;
      // `Retry-After` is an integer so round up.
      const needed = 1 - refilled;
      const retryAfter = Math.max(1, Math.ceil(needed / opts.refillPerSec));
      // Persist the refill state so concurrent requests see the same view.
      await store.set(key, { tokens: refilled, lastRefillMs: nowMs });
      return err(429, 'RateLimited', 'request rate limit exceeded', {
        'Retry-After': String(retryAfter),
      });
    }
    await store.set(key, { tokens: refilled - 1, lastRefillMs: nowMs });
    return next(req);
  };
}
