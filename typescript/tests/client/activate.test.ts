import { describe, expect, it } from 'bun:test';
import { activate } from '../../src/client/activate.ts';
import { MemoryTokenStore } from '../../src/client/token-store.ts';
import { mockFetchJson, mockFetchNetworkError } from './_helpers.ts';

describe('activate', () => {
  it('persists the returned token on success', async () => {
    const store = new MemoryTokenStore();
    let seen: { url: string; body: unknown } | null = null;
    const fetchImpl: typeof fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      seen = { url: String(url), body: JSON.parse(bodyStr) };
      return new Response(
        JSON.stringify({
          success: true,
          data: { token: 'LIC1.forged', usage_id: 'use-123', license_id: 'lic-7' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await activate('KEY-1', {
      baseUrl: 'https://issuer.example.com',
      fetchImpl,
      store,
      fingerprint: 'fp-x',
      metadata: { hostname: 'laptop' },
    });
    expect(result.token).toBe('LIC1.forged');
    expect(result.usage_id).toBe('use-123');
    expect((await store.read()).token).toBe('LIC1.forged');
    expect(seen).not.toBeNull();
    const captured = seen as unknown as { url: string; body: unknown };
    expect(captured.url).toBe('https://issuer.example.com/api/licensing/v1/activate');
    expect(captured.body).toEqual({
      license_key: 'KEY-1',
      fingerprint: 'fp-x',
      metadata: { hostname: 'laptop' },
    });
  });

  it('clears existing grace-start on fresh activation', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'old', graceStartSec: 123 });
    const fetchImpl = mockFetchJson(200, {
      success: true,
      data: { token: 'LIC1.new', usage_id: 'u', license_id: 'l' },
    });
    await activate('KEY', {
      baseUrl: 'https://x',
      fetchImpl,
      store,
      fingerprint: 'fp',
    });
    expect(await store.read()).toEqual({ token: 'LIC1.new', graceStartSec: null });
  });

  it('surfaces InvalidLicenseKey from the issuer', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'existing', graceStartSec: null });
    const fetchImpl = mockFetchJson(404, {
      success: false,
      error: { code: 'InvalidLicenseKey', message: 'no such key' },
    });
    await expect(
      activate('BAD', { baseUrl: 'https://x', fetchImpl, store, fingerprint: 'fp' }),
    ).rejects.toMatchObject({ code: 'InvalidLicenseKey' });
    // Store must be untouched.
    expect((await store.read()).token).toBe('existing');
  });

  it('surfaces SeatLimitExceeded', async () => {
    const store = new MemoryTokenStore();
    const fetchImpl = mockFetchJson(409, {
      success: false,
      error: { code: 'SeatLimitExceeded', message: 'too many seats' },
    });
    await expect(
      activate('KEY', { baseUrl: 'https://x', fetchImpl, store, fingerprint: 'fp' }),
    ).rejects.toMatchObject({ code: 'SeatLimitExceeded' });
  });

  it('maps 429 to RateLimited with retry hint', async () => {
    const store = new MemoryTokenStore();
    const fetchImpl = mockFetchJson(
      429,
      { success: false, error: { code: 'RateLimited', message: 'slow down' } },
      { 'retry-after': '42' },
    );
    await expect(
      activate('KEY', { baseUrl: 'https://x', fetchImpl, store, fingerprint: 'fp' }),
    ).rejects.toMatchObject({ code: 'RateLimited', retryAfterSec: 42 });
  });

  it('collapses network errors into IssuerUnreachable', async () => {
    const store = new MemoryTokenStore();
    await expect(
      activate('KEY', {
        baseUrl: 'https://x',
        fetchImpl: mockFetchNetworkError(),
        store,
        fingerprint: 'fp',
      }),
    ).rejects.toMatchObject({ code: 'IssuerUnreachable' });
  });

  it('rejects empty licenseKey before hitting the network', async () => {
    const store = new MemoryTokenStore();
    await expect(activate('', { baseUrl: 'x', store, fingerprint: 'fp' })).rejects.toMatchObject({
      code: 'InvalidLicenseKey',
    });
  });
});
