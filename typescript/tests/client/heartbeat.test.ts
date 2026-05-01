import { describe, expect, it } from 'bun:test';
import { createHeartbeat, sendOneHeartbeat } from '../../src/client/heartbeat.ts';
import { MemoryTokenStore } from '../../src/client/token-store.ts';
import { mockFetchJson, mockFetchNetworkError } from './_helpers.ts';

describe('sendOneHeartbeat', () => {
  it('posts the token from the store and clears grace on success', async () => {
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
    // Server contract: handleHeartbeat reads `token` from the body.
    // Earlier client versions sent {license_key, fingerprint,
    // runtime_version, timestamp} which the server never read — see the
    // revocation-latency hardening commit.
    expect(seen).toEqual({ token: 'LIC1.x' });
    expect((await store.read()).graceStartSec).toBeNull();
  });

  it('is a no-op when the store has no token', async () => {
    const store = new MemoryTokenStore();
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
    });
    expect(ok).toBe(true);
    expect(called).toBe(false); // no token → no network call
  });

  it('returns false on network failure (non-fatal, no throw)', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.x', graceStartSec: null });
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

  it('clears the store on LicenseRevoked response', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'soon-to-be-cleared', graceStartSec: null });
    let errSeen: { code?: string } | null = null;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'LicenseRevoked', message: 'license is revoked' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
      onError: (e) => {
        errSeen = e as unknown as { code?: string };
      },
    });
    expect(ok).toBe(false);
    expect(errSeen?.code).toBe('LicenseRevoked');
    expect((await store.read()).token).toBeNull();
  });

  it('clears the store on LicenseSuspended response', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'soon-to-be-cleared', graceStartSec: null });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'LicenseSuspended', message: 'license is suspended' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
    });
    expect(ok).toBe(false);
    expect((await store.read()).token).toBeNull();
  });

  it('does NOT clear the store on transient errors (rate limit)', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'must-survive', graceStartSec: null });
    let errSeen: { code?: string } | null = null;
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    const ok = await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
      onError: (e) => {
        errSeen = e as unknown as { code?: string };
      },
    });
    expect(ok).toBe(false);
    expect(errSeen?.code).toBe('RateLimited');
    expect((await store.read()).token).toBe('must-survive');
  });

  it('CAS-guards against a parallel refresh that wrote a fresh token', async () => {
    // Simulate the race: heartbeat reads token "T1", server returns
    // LicenseRevoked, but BEFORE the heartbeat can clear the store a
    // parallel refresh wrote token "T2". The CAS guard must detect the
    // change and skip the clear so T2 survives.
    const store = new MemoryTokenStore();
    await store.write({ token: 'T1', graceStartSec: null });
    let stage = 0;
    const fetchImpl: typeof fetch = async () => {
      // While the request is in-flight (between the heartbeat's first
      // store.read and its second store.read inside the catch handler),
      // simulate a parallel refresh by writing T2.
      if (stage === 0) {
        stage = 1;
        await store.write({ token: 'T2', graceStartSec: null });
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'LicenseRevoked', message: 'license is revoked' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    };
    await sendOneHeartbeat({
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
      runtimeVersion: '1.0.0',
    });
    // T2 must survive — CAS guard prevents clobbering.
    expect((await store.read()).token).toBe('T2');
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
    await store.write({ token: 'LIC1.x', graceStartSec: null });
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
