/**
 * GET /health — focused unit tests for the storage probe + RFC3339 time.
 *
 * The matrix-driven openapi-contract test only checks the success-path
 * envelope shape; this file exercises the 503-on-storage-failure path and
 * the `time` field that group 6 added.
 */

import { describe, expect, it } from 'bun:test';
import {
  type Clock,
  ed25519Backend,
  type KeyAlg,
  type SignatureBackend,
} from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

import { clientRoutes } from '../../src/http/client-handlers.ts';
import type { ClientHandlerContext } from '../../src/http/context.ts';
import { createRouter } from '../../src/http/router.ts';
import type { HandlerRequest } from '../../src/http/types.ts';

const BACKENDS_MAP: ReadonlyMap<KeyAlg, SignatureBackend> = new Map([['ed25519', ed25519Backend]]);

const CLOCK: Clock = {
  nowIso: () => '2026-04-30T00:00:00.000Z',
  unixSeconds: () => Math.floor(Date.parse('2026-04-30T00:00:00.000Z') / 1000),
};

function mkCtx(storage: ClientHandlerContext['storage']): ClientHandlerContext {
  return {
    storage,
    clock: CLOCK,
    backends: BACKENDS_MAP,
    version: '0.1.0',
    signingPassphrase: 'sign-pw',
    defaultAlg: 'ed25519',
    tokenTtlSec: 3600,
  };
}

function req(method: HandlerRequest['method'], path: string): HandlerRequest {
  return { method, path, query: {}, headers: {}, body: undefined, remoteAddr: '127.0.0.1' };
}

describe('GET /health', () => {
  it('returns 200 with {status, version, time} on storage probe success', async () => {
    const storage = new MemoryStorage();
    const router = createRouter(clientRoutes(mkCtx(storage), '/api/licensing/v1'));
    const res = await router(req('GET', '/api/licensing/v1/health'));
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      data: { status: string; version: string; time: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.version).toBe('0.1.0');
    // RFC3339 / ISO-8601 must round-trip through Date without NaN.
    expect(Number.isNaN(Date.parse(body.data.time))).toBe(false);
  });

  it('returns 503 with status=error when the storage probe fails', async () => {
    // Wrap a real storage but make listAudit reject to simulate a DB outage.
    const real = new MemoryStorage();
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'listAudit') {
          return async () => {
            throw new Error('simulated db failure');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const router = createRouter(clientRoutes(mkCtx(failing), '/api/licensing/v1'));
    const res = await router(req('GET', '/api/licensing/v1/health'));
    expect(res.status).toBe(503);
    const body = res.body as {
      success: boolean;
      data: { status: string; version: string; time: string };
    };
    // Envelope success flag stays true on 503 — the probe is a liveness
    // signal, not a typed protocol error. See client-handlers.ts comment.
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('error');
    expect(body.data.version).toBe('0.1.0');
    expect(Number.isNaN(Date.parse(body.data.time))).toBe(false);
  });
});
