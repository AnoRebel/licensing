/**
 * Express `licenseGuard` middleware.
 *
 * Usage:
 *
 *   import express from 'express';
 *   import { Licensing } from '@anorebel/licensing';
 *   import { licenseGuard } from '@anorebel/licensing/middleware/express';
 *
 *   const client = Licensing.client({ ... });
 *   const app = express();
 *
 *   app.use(licenseGuard({
 *     client,
 *     fingerprint: (req) => req.headers['x-fingerprint'] as string,
 *   }));
 *
 *   app.get('/protected', (req, res) => {
 *     // req.license is the LicenseHandle from Client.guard()
 *     res.json({ licenseId: req.license.licenseId });
 *   });
 *
 * Express is an optional peer dependency — the type is structural so
 * the package compiles without `@types/express` installed. Consumers
 * who use it pull express in themselves.
 */

import type { Client, LicenseHandle } from '../easy.ts';
import {
  type FingerprintExtractor,
  type LicenseGuardOptions,
  type OnSuccessHook,
  runGuard,
} from './core.ts';

// Structural Express types — narrow enough for our needs without
// requiring `@types/express`. Mirrors the existing
// `http/adapters/express.ts` pattern.
interface ExpressRequestLike {
  // Whatever the consumer puts here at runtime is up to them; we only
  // attach `license` to it.
  license?: LicenseHandle;
}

interface ExpressResponseLike {
  status: (code: number) => ExpressResponseLike;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => unknown;
  end: () => void;
  headersSent: boolean;
}

type ExpressNextLike = (err?: unknown) => void;

export interface ExpressLicenseGuardOptions
  extends Omit<LicenseGuardOptions<ExpressRequestLike>, 'fingerprint' | 'onSuccess'> {
  readonly fingerprint: FingerprintExtractor<ExpressRequestLike>;
  readonly onSuccess?: OnSuccessHook<ExpressRequestLike>;
}

/**
 * Build an Express RequestHandler that runs `Client.guard` on every
 * request. On success, attaches the resolved {@link LicenseHandle} to
 * `req.license` and calls `next()`. On failure, sends a JSON error
 * response with the canonical status code (see core.ts STATUS_BY_CODE)
 * and does NOT call `next()`.
 */
export function licenseGuard(opts: ExpressLicenseGuardOptions) {
  return async function licenseGuardMiddleware(
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNextLike,
  ): Promise<void> {
    const result = await runGuard(req, opts);
    if (!result.ok) {
      if (res.headersSent) return; // can't send a response — bail silently
      res.status(result.status);
      res.setHeader('Content-Type', 'application/json');
      res.json(result.body);
      return;
    }
    req.license = result.handle;
    next();
  };
}

/** TypeScript-side declaration so consumers can do `req.license.foo`
 *  without casting. Consumers add `import '@anorebel/licensing/middleware/express'`
 *  somewhere in their bundle's type-import graph (e.g. their server
 *  entry file) to pull this augmentation in.
 *
 *  We don't augment `express` directly because that would require
 *  `@types/express` to resolve at type-check time, defeating the
 *  optional-peer-dependency design. Consumers who want the augmentation
 *  can write a 3-line `.d.ts` of their own using the exported
 *  `LicenseHandle` type. */
export type { Client, LicenseHandle };
