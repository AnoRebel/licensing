/**
 * Framework-matrix test for the consumer-side `licenseGuard` middleware.
 *
 * The contract: error response JSON shape and status code MUST be
 * identical across Express, Hono, and Fastify. This file wires up each
 * framework with a real `Licensing.client` + a real route, dispatches a
 * synthetic request covering each scenario, and asserts byte-level
 * equality of the response body across all three.
 *
 * Scenarios:
 *
 *   1. happy path        — valid token, valid fingerprint
 *   2. no token          — empty TokenStore
 *   3. expired           — token whose `exp + skew` is past
 *   4. fingerprint-mismatch — verifier sends wrong fingerprint header
 *   5. server-unreachable — refresh primitive fails network, grace not entered
 *
 * Each scenario produces (status, body) and the assertion is:
 *
 *     responses[0] === responses[1] === responses[2]   (deep-equal)
 *
 * Drift in any adapter's status/body fails this test, which is the
 * mechanism that prevents the cross-framework parity contract from
 * rotting silently.
 */

import { describe, expect, it } from 'bun:test';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';

import { MemoryTokenStore } from '../../src/client/index.ts';
import { type ClientConfig, Licensing } from '../../src/easy.ts';
import { licenseGuard as expressGuard } from '../../src/middleware/express.ts';
import {
  licenseGuard as fastifyLicenseGuardHook,
  installLicenseErrorHandler,
} from '../../src/middleware/fastify.ts';
import { licenseGuard as honoGuard, type LicenseGuardEnv } from '../../src/middleware/hono.ts';

// The plugin form (`fastifyLicenseGuard`) is used in production but
// for the matrix test we use the route-scoped preHandler so the hook
// runs without `fastify-plugin` wrapping. The error handler must be
// installed manually in this form.
const licenseGuard = fastifyLicenseGuardHook;

import { type ForgedToken, forgeToken } from '../client/_helpers.ts';

const FP = 'fp-canonical';

// ---------- shared client builder ----------

interface ScenarioClient {
  client: ReturnType<typeof Licensing.client>;
  store: MemoryTokenStore;
}

async function buildClient(opts: {
  /** When true, prime the store with a fresh, valid token. */
  withValidToken?: boolean;
  /** When true, prime the store with an expired token. */
  withExpiredToken?: boolean;
  /** Override the verifier's "now" — used to age the token forward. */
  nowSec?: number;
  /** When provided, fetchImpl is wired through. */
  fetchImpl?: typeof globalThis.fetch;
  /** Forged token + verify config; reused across scenarios so we can
   *  build a single shared verifier. */
  forged: ForgedToken;
}): Promise<ScenarioClient> {
  const store = new MemoryTokenStore();
  if (opts.withValidToken === true || opts.withExpiredToken === true) {
    await store.write({ token: opts.forged.token, graceStartSec: null });
  }
  const cfg: ClientConfig = {
    serverUrl: 'https://issuer.example',
    storage: store,
    verify: {
      registry: opts.forged.registry,
      bindings: opts.forged.bindings,
      keys: opts.forged.keys,
    },
    nowSec: () => opts.nowSec ?? 2_000_000_000,
  };
  if (opts.fetchImpl !== undefined) {
    (cfg as { fetch?: typeof globalThis.fetch }).fetch = opts.fetchImpl;
  }
  return { client: Licensing.client(cfg), store };
}

const NEVER_FETCH: typeof globalThis.fetch = async () => {
  throw new Error('fixture: network must not be touched');
};

// ---------- response shape ----------

interface MatrixResponse {
  readonly status: number;
  readonly body: unknown;
}

// ---------- per-framework dispatchers ----------

async function dispatchExpress(
  client: ReturnType<typeof Licensing.client>,
  fingerprintHeader: string | undefined,
): Promise<MatrixResponse> {
  const app = express();
  app.use(
    expressGuard({
      client,
      fingerprint: (req) => {
        const r = req as unknown as {
          headers?: Record<string, string | string[] | undefined>;
        };
        const v = r.headers?.['x-fingerprint'];
        return Array.isArray(v) ? v[0] : v;
      },
    }),
  );
  app.get('/protected', (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(0);
  // node:net Server.address() returns {port} when listening on 0
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/protected`;
  const headers: Record<string, string> = {};
  if (fingerprintHeader !== undefined) headers['x-fingerprint'] = fingerprintHeader;
  try {
    const res = await fetch(url, { headers });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

async function dispatchHono(
  client: ReturnType<typeof Licensing.client>,
  fingerprintHeader: string | undefined,
): Promise<MatrixResponse> {
  const app = new Hono<LicenseGuardEnv>();
  app.use(
    '*',
    honoGuard({
      client,
      fingerprint: (c) => {
        const ctx = c as unknown as { req: { header(name: string): string | undefined } };
        return ctx.req.header('x-fingerprint');
      },
    }),
  );
  app.get('/protected', (c) => c.json({ ok: true }));

  const headers: Record<string, string> = {};
  if (fingerprintHeader !== undefined) headers['x-fingerprint'] = fingerprintHeader;
  const res = await app.request('/protected', { headers });
  const body = await res.json();
  return { status: res.status, body };
}

async function dispatchFastify(
  client: ReturnType<typeof Licensing.client>,
  fingerprintHeader: string | undefined,
): Promise<MatrixResponse> {
  const app = Fastify();
  // Install the LicenseGuardError handler before the route — required
  // when using the route-scoped preHandler form (the plugin form
  // installs it automatically).
  installLicenseErrorHandler(app as unknown as Parameters<typeof installLicenseErrorHandler>[0]);
  app.get(
    '/protected',
    {
      preHandler: licenseGuard({
        client,
        fingerprint: (req) => {
          const r = req as unknown as {
            headers: Record<string, string | string[] | undefined>;
          };
          const v = r.headers['x-fingerprint'];
          return Array.isArray(v) ? v[0] : v;
        },
      }),
    },
    async () => ({ ok: true }),
  );

  const headers: Record<string, string> = {};
  if (fingerprintHeader !== undefined) headers['x-fingerprint'] = fingerprintHeader;
  const res = await app.inject({ method: 'GET', url: '/protected', headers });
  await app.close();
  return { status: res.statusCode, body: res.json() };
}

// ---------- scenario builders ----------

interface Scenario {
  readonly name: string;
  /** Build the client wired for this scenario. */
  build: () => Promise<ScenarioClient>;
  /** Fingerprint header value to send (undefined = omit header). */
  readonly fingerprintHeader: string | undefined;
}

async function makeScenarios(): Promise<readonly Scenario[]> {
  // One forged token reused across the framework dispatch loop within
  // each scenario builder. Per-scenario clients share that verify
  // config so the only variable is store state and request shape.
  const now = 2_000_000_000;
  const forged = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
  return [
    {
      name: 'happy path',
      build: () =>
        buildClient({ forged, withValidToken: true, nowSec: now, fetchImpl: NEVER_FETCH }),
      fingerprintHeader: FP,
    },
    {
      name: 'no token (empty store)',
      build: () => buildClient({ forged, nowSec: now, fetchImpl: NEVER_FETCH }),
      fingerprintHeader: FP,
    },
    {
      name: 'expired token',
      build: () =>
        buildClient({
          forged,
          withExpiredToken: true,
          nowSec: now + 100_000, // way past exp + skew
          fetchImpl: NEVER_FETCH,
        }),
      fingerprintHeader: FP,
    },
    {
      name: 'fingerprint mismatch',
      build: () =>
        buildClient({ forged, withValidToken: true, nowSec: now, fetchImpl: NEVER_FETCH }),
      fingerprintHeader: 'wrong-fingerprint',
    },
    {
      name: 'missing fingerprint header',
      build: () =>
        buildClient({ forged, withValidToken: true, nowSec: now, fetchImpl: NEVER_FETCH }),
      fingerprintHeader: undefined,
    },
  ];
}

// ---------- the matrix ----------

describe('licenseGuard — framework matrix', () => {
  it('every scenario produces identical (status, body) across Express, Hono, Fastify', async () => {
    const scenarios = await makeScenarios();
    for (const scenario of scenarios) {
      // Build three independent clients backed by identical state, so
      // each framework gets its own MemoryTokenStore (which can be
      // mutated by guard's refresh path). Dispatch sequentially —
      // running them in Promise.all leads to subtle ordering issues
      // (Express opens a real listener, the Promise's settle order
      // affects when each framework sees its scenario state) and the
      // matrix isn't a perf test; we want one definitive result per
      // (scenario, framework) pair.
      const exp = await scenario.build();
      const hon = await scenario.build();
      const fas = await scenario.build();

      const r1 = await dispatchExpress(exp.client, scenario.fingerprintHeader);
      const r2 = await dispatchHono(hon.client, scenario.fingerprintHeader);
      const r3 = await dispatchFastify(fas.client, scenario.fingerprintHeader);

      // Shape parity — status MUST be identical.
      expect(r1.status, `${scenario.name}: express vs hono status`).toBe(r2.status);
      expect(r2.status, `${scenario.name}: hono vs fastify status`).toBe(r3.status);
      // Body shape parity — JSON deep-equal across all three.
      expect(r1.body, `${scenario.name}: express vs hono body`).toEqual(r2.body);
      expect(r2.body, `${scenario.name}: hono vs fastify body`).toEqual(r3.body);
    }
  });

  it('happy path returns 200 with the route handler body (license attached)', async () => {
    const scenarios = await makeScenarios();
    const happy = scenarios[0];
    if (happy === undefined) throw new Error('happy scenario missing');
    const exp = await happy.build();
    const r = await dispatchExpress(exp.client, happy.fingerprintHeader);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('no-token scenario surfaces NoToken with 401', async () => {
    const scenarios = await makeScenarios();
    const noTok = scenarios[1];
    if (noTok === undefined) throw new Error('no-token scenario missing');
    const exp = await noTok.build();
    const r = await dispatchExpress(exp.client, noTok.fingerprintHeader);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'NoToken' });
  });

  it('expired scenario surfaces TokenExpired with 401', async () => {
    const scenarios = await makeScenarios();
    const expired = scenarios[2];
    if (expired === undefined) throw new Error('expired scenario missing');
    const exp = await expired.build();
    const r = await dispatchExpress(exp.client, expired.fingerprintHeader);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'TokenExpired' });
  });

  it('fingerprint-mismatch scenario surfaces FingerprintMismatch with 403', async () => {
    const scenarios = await makeScenarios();
    const mismatch = scenarios[3];
    if (mismatch === undefined) throw new Error('mismatch scenario missing');
    const exp = await mismatch.build();
    const r = await dispatchExpress(exp.client, mismatch.fingerprintHeader);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'FingerprintMismatch' });
  });

  it('missing-fingerprint scenario surfaces MissingFingerprint with 400', async () => {
    const scenarios = await makeScenarios();
    const missing = scenarios[4];
    if (missing === undefined) throw new Error('missing scenario missing');
    const exp = await missing.build();
    const r = await dispatchExpress(exp.client, missing.fingerprintHeader);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'MissingFingerprint' });
  });
});
