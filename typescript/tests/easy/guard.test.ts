/**
 * client.guard() — high-level guard tests.
 *
 * Covers: no token, valid token (active), valid token (grace from claim),
 * expired token, fingerprint mismatch, refresh-not-due path, missing
 * verify config error.
 *
 * Refresh-network-failure → grace-entered and grace-exhausted scenarios are
 * covered by the underlying `refresh()` primitive's tests; we just confirm
 * `guard()` surfaces the typed errors when refresh() throws hard failures.
 */

import { describe, expect, it } from 'bun:test';

import { Licensing } from '@anorebel/licensing';
import { MemoryTokenStore } from '@anorebel/licensing/client';

import { forgeToken, mockFetchJson, mockFetchNetworkError } from '../client/_helpers.ts';

const FP = 'fp-canonical';

async function setupGuardClient(opts: {
  storedToken?: string | null;
  graceStartSec?: number | null;
  fetchImpl?: typeof globalThis.fetch;
  registry?: Awaited<ReturnType<typeof forgeToken>>['registry'];
  bindings?: Awaited<ReturnType<typeof forgeToken>>['bindings'];
  keys?: Awaited<ReturnType<typeof forgeToken>>['keys'];
  nowSec?: number;
  gracePeriodSec?: number;
}) {
  const store = new MemoryTokenStore();
  if (opts.storedToken !== undefined) {
    await store.write({
      token: opts.storedToken,
      graceStartSec: opts.graceStartSec ?? null,
    });
  }
  const fetchImpl = opts.fetchImpl ?? mockFetchJson(404, { ok: false });
  const config = {
    serverUrl: 'https://issuer.example',
    storage: store,
    fetch: fetchImpl,
    nowSec: () => opts.nowSec ?? 2_000_000_000,
    ...(opts.gracePeriodSec !== undefined ? { gracePeriodSec: opts.gracePeriodSec } : {}),
    ...(opts.registry !== undefined && opts.bindings !== undefined && opts.keys !== undefined
      ? { verify: { registry: opts.registry, bindings: opts.bindings, keys: opts.keys } }
      : {}),
  };
  return Licensing.client(config);
}

describe('Licensing.client — guard', () => {
  it('throws NoToken when storage is empty', async () => {
    const f = await forgeToken({ usage_fingerprint: FP });
    const client = await setupGuardClient({
      storedToken: null,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
    });
    await expect(client.guard({ fingerprint: FP })).rejects.toMatchObject({ code: 'NoToken' });
  });

  it('returns a handle for a valid active token', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const client = await setupGuardClient({
      storedToken: f.token,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
    });
    const handle = await client.guard({ fingerprint: FP });
    expect(handle.licenseId).toBe('lic-1');
    expect(handle.usageId).toBe('use-1');
    expect(handle.status).toBe('active');
    expect(handle.isInGrace).toBe(false);
    expect(handle.graceStartedAt).toBeNull();
  });

  it('throws TokenExpired for a token past exp+skew', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const client = await setupGuardClient({
      storedToken: f.token,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now + 100_000, // way past exp + skew
    });
    await expect(client.guard({ fingerprint: FP })).rejects.toMatchObject({ code: 'TokenExpired' });
  });

  it('throws FingerprintMismatch for the wrong device', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    const client = await setupGuardClient({
      storedToken: f.token,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
    });
    await expect(client.guard({ fingerprint: 'wrong-fingerprint' })).rejects.toMatchObject({
      code: 'FingerprintMismatch',
    });
  });

  it('surfaces grace state from the stored grace_started_at marker', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    // Mock fetch unreachable so refresh enters/continues grace; mark grace
    // as having started 1 day ago.
    const client = await setupGuardClient({
      storedToken: f.token,
      graceStartSec: now - 86_400,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
      fetchImpl: mockFetchNetworkError(),
      gracePeriodSec: 7 * 86_400,
    });
    const handle = await client.guard({ fingerprint: FP });
    // The token's status is still active; grace flag bubbles up from the store.
    expect(handle.isInGrace).toBe(true);
    expect(handle.graceStartedAt).toBe(now - 86_400);
  });

  it('throws GraceExpired when the grace window has elapsed', async () => {
    const now = 2_000_000_000;
    // Token forced to require online refresh: force_online_after in the past.
    const f = await forgeToken(
      { usage_fingerprint: FP, force_online_after: now - 100 },
      { nowSec: now },
    );
    const client = await setupGuardClient({
      storedToken: f.token,
      graceStartSec: now - 8 * 86_400, // 8 days ago — past 7-day window
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
      fetchImpl: mockFetchNetworkError(),
      gracePeriodSec: 7 * 86_400,
    });
    await expect(client.guard({ fingerprint: FP })).rejects.toMatchObject({
      code: 'GraceExpired',
    });
  });

  it('refresh-not-due path: never touches the network for a fresh token', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    let fetchCalls = 0;
    const fetchImpl = async (...args: Parameters<typeof globalThis.fetch>) => {
      fetchCalls++;
      return mockFetchJson(200, { success: true })(args[0] as string);
    };
    const client = await setupGuardClient({
      storedToken: f.token,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
      fetchImpl,
    });
    await client.guard({ fingerprint: FP });
    expect(fetchCalls).toBe(0);
  });

  it('throws when verify config is missing', async () => {
    const client = await setupGuardClient({ storedToken: 'whatever' });
    await expect(client.guard({ fingerprint: FP })).rejects.toThrow(/verify/);
  });

  it('validate() works without invoking the network', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken({ usage_fingerprint: FP }, { nowSec: now });
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return new Response(null, { status: 500 });
    };
    const client = await setupGuardClient({
      storedToken: f.token,
      registry: f.registry,
      bindings: f.bindings,
      keys: f.keys,
      nowSec: now,
      fetchImpl,
    });
    const result = await client.validate({ fingerprint: FP });
    expect(result.license_id).toBe('lic-1');
    expect(fetchCalls).toBe(0);
  });
});

describe('Licensing.client — heartbeat', () => {
  it('returns a Heartbeat with start/stop/tickNow methods', () => {
    const client = Licensing.client({
      serverUrl: 'https://issuer.example',
      storage: new MemoryTokenStore(),
    });
    const hb = client.heartbeat({
      licenseKey: 'LIC-AAAA-BBBB-CCCC-DDDD-EEEE',
      fingerprint: FP,
      runtimeVersion: '0.0.0-test',
      intervalSec: 60,
    });
    expect(typeof hb.start).toBe('function');
    expect(typeof hb.stop).toBe('function');
    expect(typeof hb.tickNow).toBe('function');
    hb.stop(); // safe-when-not-started
  });
});
