/**
 * Framework-agnostic HTTP handlers for the licensing issuer.
 *
 * Typical wiring:
 *
 *   import { clientRoutes, createRouter, bearerAuth, sharedSecretVerifier,
 *            rateLimit } from '@anorebel/licensing/http';
 *   import { createHonoApp } from '@anorebel/licensing/http/adapters/hono';
 *
 *   const router = createRouter(
 *     clientRoutes(ctx, '/api/licensing/v1'),
 *     {
 *       middleware: [
 *         rateLimit({ burst: 60, refillPerSec: 1 }),
 *         bearerAuth({ verify: sharedSecretVerifier(process.env.ADMIN_TOKEN!) }),
 *       ],
 *     },
 *   );
 *
 *   const app = createHonoApp(router);
 *   export default app;
 */

export * from './admin-handlers.ts';
export * from './auth.ts';
export * from './client-handlers.ts';
export * from './context.ts';
export * from './envelope.ts';
export * from './rate-limit.ts';
export * from './router.ts';
export * from './types.ts';
export * from './validation.ts';
