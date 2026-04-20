import { describe, expect, it } from 'bun:test';
import { createHeartbeat, sendOneHeartbeat } from '../../src/client/heartbeat.ts';
import { MemoryTokenStore } from '../../src/client/token-store.ts';
import { mockFetchJson, mockFetchNetworkError } from './_helpers.ts';

describe('sendOneHeartbeat', () => {
  it('posts the expected payload and clears grace on success', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.x', graceStartSec: 999 });
    let seen: unknown = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      seen = JSON.parse(bodyStr);
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
      nowSec: () => 1234,
    });
    expect(ok).toBe(true);
    expect(seen).toEqual({
      license_key: 'KEY',
      fingerprint: 'fp',
      runtime_version: '1.0.0',
      timestamp: 1234,
    });
    expect((await store.read()).graceStartSec).toBeNull();
  });

  it('returns false on network failure (non-fatal, no throw)', async () => {
    const store = new MemoryTokenStore();
    let errSeen: Error | null = null;
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl: mockFetchNetworkError(),
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
      onError: (e) => {
        errSeen = e;
      },
    });
    expect(ok).toBe(false);
    expect(errSeen).not.toBeNull();
  });
});

describe('createHeartbeat', () => {
  it('clamps interval below minimum to 60s', async () => {
    const store = new MemoryTokenStore();
    let warned: Error | null = null;
    const hb = createHeartbeat({
      baseUrl: 'https://x',
      fetchImpl: mockFetchJson(200, { success: true, data: {} }),
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
      intervalSec: 10,
      onError: (e) => {
        warned = e;
      },
    });
    expect(warned).not.toBeNull();
    expect((warned as unknown as Error).message).toContain('below minimum');
    hb.stop();
  });

  it('tickNow calls the issuer immediately', async () => {
    const store = new MemoryTokenStore();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const hb = createHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
    });
    await hb.tickNow();
    await hb.tickNow();
    expect(calls).toBe(2);
    hb.stop();
  });

  it('start + stop is idempotent', () => {
    const store = new MemoryTokenStore();
    const hb = createHeartbeat({
      baseUrl: 'https://x',
      fetchImpl: mockFetchJson(200, { success: true, data: {} }),
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
    });
    hb.start();
    hb.start(); // second start no-op
    hb.stop();
    hb.stop(); // second stop no-op — must not throw
  });
});
