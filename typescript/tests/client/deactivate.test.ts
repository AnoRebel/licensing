import { describe, expect, it } from 'bun:test';
import { deactivate } from '../../src/client/deactivate.ts';
import { MemoryTokenStore } from '../../src/client/token-store.ts';
import { mockFetchJson, mockFetchNetworkError } from './_helpers.ts';

describe('deactivate', () => {
  it('clears store on successful issuer response', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.old', graceStartSec: null });
    const fetchImpl = mockFetchJson(200, { success: true, data: {} });
    const result = await deactivate('user-initiated', {
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
    });
    expect(result.issuerConfirmed).toBe(true);
    expect((await store.read()).token).toBeNull();
  });

  it('clears store when issuer says InvalidLicenseKey (stale state)', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.stale', graceStartSec: null });
    const fetchImpl = mockFetchJson(404, {
      success: false,
      error: { code: 'InvalidLicenseKey', message: 'gone' },
    });
    const result = await deactivate('reason', {
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
    });
    expect(result.issuerConfirmed).toBe(false);
    expect((await store.read()).token).toBeNull();
  });

  it('clears store when issuer says LicenseRevoked', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.revoked', graceStartSec: null });
    const fetchImpl = mockFetchJson(403, {
      success: false,
      error: { code: 'LicenseRevoked', message: 'nope' },
    });
    const result = await deactivate('reason', {
      baseUrl: 'https://x',
      fetchImpl,
      store,
      licenseKey: 'KEY',
      fingerprint: 'fp',
    });
    expect(result.issuerConfirmed).toBe(false);
    expect((await store.read()).token).toBeNull();
  });

  it('preserves store on network error (retryable)', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.keep', graceStartSec: null });
    await expect(
      deactivate('reason', {
        baseUrl: 'https://x',
        fetchImpl: mockFetchNetworkError(),
        store,
        licenseKey: 'KEY',
        fingerprint: 'fp',
      }),
    ).rejects.toMatchObject({ code: 'IssuerUnreachable' });
    expect((await store.read()).token).toBe('LIC1.keep');
  });

  it('requires a non-empty reason', async () => {
    const store = new MemoryTokenStore();
    await expect(
      deactivate('', {
        baseUrl: 'x',
        store,
        licenseKey: 'KEY',
        fingerprint: 'fp',
      }),
    ).rejects.toThrow('non-empty reason');
  });
});
