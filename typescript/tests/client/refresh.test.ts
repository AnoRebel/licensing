import { describe, expect, it } from 'bun:test';
import { refresh } from '../../src/client/refresh.ts';
import { MemoryTokenStore } from '../../src/client/token-store.ts';
import { forgeToken, mockFetchJson, mockFetchNetworkError } from './_helpers.ts';

describe('refresh — proactive trigger', () => {
  it('not-due when lifetime remaining above threshold', async () => {
    const now = 2_000_000_000;
    // Full hour token: now is right at nbf+60, so >95% remains.
    const f = await forgeToken({ usage_fingerprint: 'fp' }, { nowSec: now });
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    const fetchImpl = mockFetchJson(500, {}); // should never be called
    const out = await refresh({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      nowSec: now,
    });
    expect(out.kind).toBe('not-due');
  });

  it('fires when under 25% remaining', async () => {
    const nbf = 1_000_000_000;
    const exp = nbf + 1000;
    // 10% remaining.
    const now = exp - 100;
    const f = await forgeToken({ usage_fingerprint: 'fp', iat: nbf, nbf, exp }, { nowSec: now });
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    const fetchImpl = mockFetchJson(200, {
      success: true,
      data: { token: 'LIC1.new' },
    });
    const out = await refresh({ baseUrl: 'https://x', fetchImpl, store, nowSec: now });
    expect(out.kind).toBe('refreshed');
    expect((await store.read()).token).toBe('LIC1.new');
  });

  it('swallows network error on proactive refresh (non-fatal)', async () => {
    const nbf = 1_000_000_000;
    const exp = nbf + 1000;
    const now = exp - 100;
    const f = await forgeToken({ usage_fingerprint: 'fp', iat: nbf, nbf, exp }, { nowSec: now });
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    const out = await refresh({
      baseUrl: 'https://x',
      fetchImpl: mockFetchNetworkError(),
      store,
      nowSec: now,
    });
    expect(out.kind).toBe('not-due');
    // Token unchanged.
    expect((await store.read()).token).toBe(f.token);
  });
});

describe('refresh — forced refresh (force_online_after passed)', () => {
  it('enters grace on network error when grace enabled', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    const out = await refresh({
      baseUrl: 'https://x',
      fetchImpl: mockFetchNetworkError(),
      store,
      nowSec: now,
    });
    expect(out.kind).toBe('grace-entered');
    const state = await store.read();
    expect(state.graceStartSec).toBe(now);
  });

  it('GraceExpired when grace window elapsed', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    const graceStart = now - 8 * 24 * 3600; // 8 days ago
    await store.write({ token: f.token, graceStartSec: graceStart });
    await expect(
      refresh({
        baseUrl: 'https://x',
        fetchImpl: mockFetchNetworkError(),
        store,
        nowSec: now,
      }),
    ).rejects.toMatchObject({ code: 'GraceExpired' });
  });

  it('continues existing grace when network still down but window open', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    const graceStart = now - 2 * 24 * 3600;
    await store.write({ token: f.token, graceStartSec: graceStart });
    const out = await refresh({
      baseUrl: 'https://x',
      fetchImpl: mockFetchNetworkError(),
      store,
      nowSec: now,
    });
    expect(out.kind).toBe('grace-continued');
    if (out.kind === 'grace-continued') {
      expect(out.graceStartSec).toBe(graceStart);
    }
  });

  it('clears grace on successful forced refresh', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: now - 1000 });
    const fetchImpl = mockFetchJson(200, { success: true, data: { token: 'LIC1.renewed' } });
    const out = await refresh({ baseUrl: 'https://x', fetchImpl, store, nowSec: now });
    expect(out.kind).toBe('refreshed');
    expect(await store.read()).toEqual({ token: 'LIC1.renewed', graceStartSec: null });
  });

  it('surfaces RequiresOnlineRefresh when grace disabled and network down', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    await expect(
      refresh({
        baseUrl: 'https://x',
        fetchImpl: mockFetchNetworkError(),
        store,
        nowSec: now,
        graceWindowSec: 0,
      }),
    ).rejects.toMatchObject({ code: 'RequiresOnlineRefresh' });
  });

  it('surfaces LicenseRevoked without entering grace (authoritative)', async () => {
    const now = 2_000_000_000;
    const f = await forgeToken(
      { usage_fingerprint: 'fp', force_online_after: now - 10 },
      { nowSec: now },
    );
    const store = new MemoryTokenStore();
    await store.write({ token: f.token, graceStartSec: null });
    const fetchImpl = mockFetchJson(403, {
      success: false,
      error: { code: 'LicenseRevoked', message: 'gone' },
    });
    await expect(
      refresh({ baseUrl: 'https://x', fetchImpl, store, nowSec: now }),
    ).rejects.toMatchObject({ code: 'LicenseRevoked' });
    // Store unchanged — no grace entry on authoritative error.
    expect((await store.read()).graceStartSec).toBeNull();
  });
});

describe('refresh — edge cases', () => {
  it('throws NoToken when store is empty', async () => {
    const store = new MemoryTokenStore();
    await expect(
      refresh({
        baseUrl: 'https://x',
        fetchImpl: mockFetchJson(200, {}),
        store,
        nowSec: 1_000_000_000,
      }),
    ).rejects.toMatchObject({ code: 'NoToken' });
  });
});
