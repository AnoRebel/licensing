/**
 * Group 6.6 — health-based disambiguation in `Client.refresh()`.
 *
 * When the refresh primitive enters/continues grace because /refresh was
 * unreachable, the high-level wrapper probes GET /health to distinguish
 * a real network outage from a partial outage where /refresh is broken
 * but the issuer process is alive.
 *
 *   - health 200 + refresh-fail → throw `IssuerProtocolError`, roll back
 *     the just-written grace marker. No grace.
 *   - health-fail + refresh-fail → preserve the original grace state and
 *     return the `grace-entered` / `grace-continued` outcome.
 */

import { describe, expect, it } from 'bun:test';

import { Licensing } from '@anorebel/licensing';
import { MemoryTokenStore } from '@anorebel/licensing/client';

import { forgeToken } from '../client/_helpers.ts';

const FP = 'fp-canonical';

/**
 * Compose a fetch mock from per-path responder functions. The path matched
 * is the suffix after `/api/licensing/v1`, so `/refresh` and `/health` are
 * matched verbatim.
 */
function mkFetch(
  routes: Readonly<Record<string, (url: string, init?: RequestInit) => Promise<Response>>>,
): typeof globalThis.fetch {
  return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    for (const [suffix, responder] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return responder(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('Licensing.client — refresh health disambiguation', () => {
  it('health-200 + refresh-fail → throws IssuerProtocolError, no grace marker', async () => {
    const now = 2_000_000_000;
    // Token forced to require online refresh so the refresh path is taken.
    const f = await forgeToken(
      { usage_fingerprint: FP, force_online_after: now - 100 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });

    const fetchImpl = mkFetch({
      '/refresh': async () => {
        // simulate transport-level failure on /refresh
        throw new Error('ECONNREFUSED');
      },
      '/health': async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { status: 'ok', version: '0.1.0', time: new Date().toISOString() },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const client = Licensing.client({
      serverUrl: 'https://issuer.example',
      storage: store,
      fetch: fetchImpl,
      nowSec: () => now,
      gracePeriodSec: 7 * 86_400,
      verify: { registry: f.registry, bindings: f.bindings, keys: f.keys },
    });

    await expect(client.refresh()).rejects.toMatchObject({ code: 'IssuerProtocolError' });

    // Grace marker MUST NOT have been persisted — disambiguation rolled
    // it back because /health proved the issuer is up.
    const after = await store.read();
    expect(after.graceStartSec).toBeNull();
  });

  it('health-fail + refresh-fail → returns grace-entered, marker persisted', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, force_online_after: now - 100 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });

    const fetchImpl = mkFetch({
      '/refresh': async () => {
        throw new Error('ECONNREFUSED');
      },
      '/health': async () => {
        // Real network outage — health probe also fails.
        throw new Error('ECONNREFUSED');
      },
    });

    const client = Licensing.client({
      serverUrl: 'https://issuer.example',
      storage: store,
      fetch: fetchImpl,
      nowSec: () => now,
      gracePeriodSec: 7 * 86_400,
      verify: { registry: f.registry, bindings: f.bindings, keys: f.keys },
    });

    const out = await client.refresh();
    expect(out.kind).toBe('grace-entered');
    const after = await store.read();
    expect(after.graceStartSec).toBe(now);
  });

  it('health-503 + refresh-fail → returns grace-entered (503 counts as not-healthy)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: FP, force_online_after: now - 100 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });

    const fetchImpl = mkFetch({
      '/refresh': async () => {
        throw new Error('ECONNREFUSED');
      },
      '/health': async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { status: 'error', version: '0.1.0', time: new Date().toISOString() },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
    });

    const client = Licensing.client({
      serverUrl: 'https://issuer.example',
      storage: store,
      fetch: fetchImpl,
      nowSec: () => now,
      gracePeriodSec: 7 * 86_400,
      verify: { registry: f.registry, bindings: f.bindings, keys: f.keys },
    });

    const out = await client.refresh();
    expect(out.kind).toBe('grace-entered');
    const after = await store.read();
    expect(after.graceStartSec).toBe(now);
  });
});
