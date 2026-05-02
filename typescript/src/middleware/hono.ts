/**
 * Hono `licenseGuard` middleware.
 *
 * Usage:
 *
 *   import { Hono } from 'hono';
 *   import { Licensing } from '@anorebel/licensing';
 *   import { licenseGuard, type LicenseGuardEnv } from '@anorebel/licensing/middleware/hono';
 *
 *   const client = Licensing.client({ ... });
 *
 *   // Pass the env type so c.get('license') is fully typed downstream.
 *   const app = new Hono<LicenseGuardEnv>();
 *
 *   app.use('*', licenseGuard({
 *     client,
 *     fingerprint: (c) => c.req.header('x-fingerprint'),
 *   }));
 *
 *   app.get('/protected', (c) => {
 *     // c.get('license') is the LicenseHandle from Client.guard()
 *     const license = c.get('license');
 *     return c.json({ licenseId: license.licenseId });
 *   });
 *
 * If you already have your own `Variables`, intersect them:
 *
 *   type Env = {
 *     Variables: LicenseGuardEnv['Variables'] & { user: User; … }
 *   };
 *
 * Hono is an optional peer dependency. The type is structural so the
 * package compiles without `hono` installed. Consumers who use it pull
 * hono in themselves.
 */

import type { Client, LicenseHandle } from '../easy.ts';
import {
  type FingerprintExtractor,
  type LicenseGuardOptions,
  type OnSuccessHook,
  runGuard,
} from './core.ts';

// Structural Hono Context — narrow enough for our needs. Mirrors the
// existing http/adapters/hono.ts pattern.
interface HonoContextLike {
  set: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
  json: (body: unknown, status?: number) => unknown;
  header: (name: string, value: string) => void;
}

type HonoNextLike = () => Promise<void>;

export interface HonoLicenseGuardOptions
  extends Omit<LicenseGuardOptions<HonoContextLike>, 'fingerprint' | 'onSuccess'> {
  readonly fingerprint: FingerprintExtractor<HonoContextLike>;
  readonly onSuccess?: OnSuccessHook<HonoContextLike>;
}

/**
 * Build a Hono middleware that runs `Client.guard` on every request.
 * On success, sets `c.set('license', handle)` and calls `next()`. On
 * failure, returns a JSON response with the canonical status code and
 * does NOT call `next()`.
 *
 * The handle key is `'license'` — fixed, NOT configurable. Configurable
 * keys would defeat the "consistent across frameworks" property
 * (a multi-framework consumer would have to remember which key each
 * adapter uses). Consumers who need a different key can build their
 * own thin wrapper.
 */
export function licenseGuard(opts: HonoLicenseGuardOptions) {
  return async function licenseGuardMiddleware(
    c: HonoContextLike,
    next: HonoNextLike,
  ): Promise<unknown | undefined> {
    const result = await runGuard(c, opts);
    if (!result.ok) {
      c.header('Content-Type', 'application/json');
      return c.json(result.body, result.status);
    }
    c.set('license', result.handle);
    await next();
    return undefined;
  };
}

/**
 * Hono `Env` shape exporting the `license` variable for `c.get('license')`
 * type safety. Pass to `new Hono<LicenseGuardEnv>()` (or intersect with
 * your own Variables) to get full inference downstream.
 */
export interface LicenseGuardEnv {
  readonly Variables: {
    readonly license: LicenseHandle;
  };
}

export type { Client, LicenseHandle };
