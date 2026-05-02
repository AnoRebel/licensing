/**
 * Fastify `licenseGuard` plugin.
 *
 * Two usage shapes:
 *
 * 1. Plugin form (recommended for app-wide):
 *
 *      import Fastify from 'fastify';
 *      import { Licensing } from '@anorebel/licensing';
 *      import { fastifyLicenseGuard } from '@anorebel/licensing/middleware/fastify';
 *
 *      const app = Fastify();
 *      await app.register(fastifyLicenseGuard, {
 *        client: Licensing.client({ ... }),
 *        fingerprint: (req) => req.headers['x-fingerprint'] as string,
 *      });
 *
 *      // To make the plugin's decorator visible OUTSIDE the encapsulation
 *      // context (e.g. for declaration-merged FastifyRequest typing
 *      // throughout the app), wrap with fastify-plugin:
 *      //
 *      //   import fp from 'fastify-plugin';
 *      //   await app.register(fp(fastifyLicenseGuard), { ... });
 *
 * 2. preHandler-hook form (route-scoped):
 *
 *      app.get('/protected', { preHandler: licenseGuard({ client, fingerprint }) }, async (req) => {
 *        return { licenseId: (req as any).license.licenseId };
 *      });
 *
 * Fastify is an optional peer dependency. The types are structural so
 * the package compiles without `fastify` installed. Consumers who use
 * it pull fastify in themselves and (optionally) augment FastifyRequest:
 *
 *      import type { LicenseHandle } from '@anorebel/licensing/middleware/fastify';
 *      declare module 'fastify' {
 *        interface FastifyRequest { license?: LicenseHandle }
 *      }
 */

import type { Client, LicenseHandle } from '../easy.ts';
import {
  type FingerprintExtractor,
  type LicenseGuardOptions,
  type OnSuccessHook,
  runGuard,
} from './core.ts';

// Structural Fastify types — narrow enough for our needs without
// requiring `fastify` to resolve at type-check time.
interface FastifyRequestLike {
  // Whatever the consumer puts here at runtime is up to them; we attach
  // `license` after a successful guard.
  license?: LicenseHandle;
}

interface FastifyReplyLike {
  code: (status: number) => FastifyReplyLike;
  header: (name: string, value: string) => FastifyReplyLike;
  send: (body?: unknown) => FastifyReplyLike;
}

interface FastifyInstanceLike {
  /** Pre-allocate the `license` slot on every request. Calling
   *  decorateRequest at plugin-register time lets Fastify keep the
   *  request shape monomorphic — without it, every assignment in the
   *  hook would deopt the V8 inline cache. */
  decorateRequest: (name: string, value: unknown) => unknown;
  /** Install the preHandler hook. The hook resolves to void on success;
   *  failure is signalled by throwing `LicenseGuardError`, which the
   *  Fastify error pipeline converts into the wire response. */
  addHook: (
    name: 'preHandler',
    fn: (req: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>,
  ) => unknown;
  /** Install the error handler that recognises LicenseGuardError. */
  setErrorHandler: (
    fn: (err: Error, req: FastifyRequestLike, reply: FastifyReplyLike) => void,
  ) => unknown;
}

/** Subset of FastifyInstance required by `installLicenseErrorHandler`. */
interface FastifyInstanceWithErrorHandler {
  setErrorHandler: (
    fn: (err: Error, req: FastifyRequestLike, reply: FastifyReplyLike) => void,
  ) => unknown;
}

type FastifyDoneLike = (err?: Error) => void;

export interface FastifyLicenseGuardOptions
  extends Omit<LicenseGuardOptions<FastifyRequestLike>, 'fingerprint' | 'onSuccess'> {
  readonly fingerprint: FingerprintExtractor<FastifyRequestLike>;
  readonly onSuccess?: OnSuccessHook<FastifyRequestLike>;
}

/**
 * The error thrown by the preHandler when the guard rejects.
 *
 * Why throw instead of `reply.send` + `return reply`? In Fastify v5,
 * `reply.sent` is a getter backed by `reply.raw.writableEnded` (plus
 * the `kReplyHijacked` symbol). After `reply.send()`, `writableEnded`
 * does NOT flip synchronously — the underlying `http.ServerResponse`
 * stream finalizes asynchronously. Meanwhile, the async hook runner's
 * `handleResolve` immediately calls `next()` regardless of the resolved
 * value (see fastify/lib/hooks.js, `hookRunnerGenerator`); next() runs
 * `preHandlerCallback`, which checks `reply.sent` and finds it false,
 * so it proceeds to the route handler. Result: the route handler runs
 * even though the preHandler "successfully" sent a response, producing
 * a duplicate write that `light-my-request` (the inject harness) and
 * sometimes real `http.ServerResponse` instances reject with
 * ERR_HTTP_HEADERS_SENT.
 *
 * The canonical Fastify pattern for an async preHandler that wants to
 * short-circuit is to throw an error. The hook runner's
 * `handleReject(err)` calls back with err set; `preHandlerCallback`
 * sees the error and routes through Fastify's error pipeline, which
 * sets `kReplyIsError` and skips the route handler cleanly.
 *
 * `LicenseGuardError` carries the status code (Fastify's default
 * setErrorStatusCode reads `err.statusCode`) and the structured body.
 * The plugin (and the route-scoped `licenseGuard` form) installs a
 * `setErrorHandler` that recognises this error and emits the JSON body
 * matching the Express and Hono adapters byte-for-byte.
 */
export class LicenseGuardError extends Error {
  readonly statusCode: number;
  readonly body: { readonly error: string; readonly message: string };
  constructor(statusCode: number, body: { error: string; message: string }) {
    super(body.message);
    this.name = 'LicenseGuardError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Build a Fastify preHandler hook. Same contract as the Express
 *  middleware: success attaches `req.license`, failure throws
 *  `LicenseGuardError` which Fastify's error pipeline turns into the
 *  matching JSON response.
 *
 *  IMPORTANT: when used as a route-scoped preHandler (without
 *  registering the plugin), the consumer MUST install a Fastify error
 *  handler that recognises `LicenseGuardError` and emits its body —
 *  otherwise Fastify's default error handler will produce a generic
 *  `{statusCode, error, message}` shape that diverges from the other
 *  adapters. Use `installLicenseErrorHandler(app)` for that, or
 *  prefer the plugin form (`fastifyLicenseGuard`) which installs the
 *  handler automatically. */
export function licenseGuard(opts: FastifyLicenseGuardOptions) {
  return async function licenseGuardPreHandler(
    req: FastifyRequestLike,
    _reply: FastifyReplyLike,
  ): Promise<void> {
    const result = await runGuard(req, opts);
    if (!result.ok) {
      throw new LicenseGuardError(result.status, result.body);
    }
    req.license = result.handle;
  };
}

/** Install the Fastify error handler that turns `LicenseGuardError`
 *  thrown from the preHandler into the canonical JSON wire response.
 *  The `fastifyLicenseGuard` plugin installs this automatically;
 *  consumers who use the route-scoped `licenseGuard()` preHandler
 *  directly should call this once at app startup. */
export function installLicenseErrorHandler(instance: FastifyInstanceWithErrorHandler): void {
  instance.setErrorHandler((err, _req, reply) => {
    if (err instanceof LicenseGuardError) {
      reply.code(err.statusCode);
      reply.header('Content-Type', 'application/json');
      reply.send(err.body);
      return;
    }
    // Not ours — let Fastify handle it (re-throw isn't supported here;
    // the simplest restore is to send a 500 with Fastify's default
    // shape).
    reply.code(500);
    reply.send({ error: 'InternalError', message: err.message });
  });
}

/** Fastify plugin form. Register with `app.register(fastifyLicenseGuard, opts)`
 *  to install the guard as an app-wide preHandler.
 *
 *  Pre-allocates the `request.license` slot via `decorateRequest` so
 *  the per-request assignment stays on Fastify's fast path
 *  (monomorphic request-object shape).
 *
 *  This callback signature is what `app.register` expects when the
 *  plugin is NOT wrapped in `fastify-plugin`. To break out of plugin
 *  encapsulation (e.g. so `request.license` is visible to TypeScript
 *  via declaration-merging across the whole app), wrap with `fp`:
 *
 *      app.register(fp(fastifyLicenseGuard), opts)
 */
export function fastifyLicenseGuard(
  instance: FastifyInstanceLike,
  opts: FastifyLicenseGuardOptions,
  done: FastifyDoneLike,
): void {
  // Pre-allocate the slot. `null` initial value is the documented
  // pattern; consumers using declaration-merging on FastifyRequest
  // should type the field as `LicenseHandle | null`.
  instance.decorateRequest('license', null);
  // Install the error handler BEFORE the hook so a thrown
  // LicenseGuardError gets caught by our shape-matching emitter.
  installLicenseErrorHandler(instance);
  instance.addHook('preHandler', licenseGuard(opts));
  done();
}

export type { Client, LicenseHandle };
