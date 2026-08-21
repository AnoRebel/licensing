/**
 * High-level issuer integration tests. Exercises the `Licensing.issuer()`
 * factory end-to-end against the memory adapter — no primitive imports
 * past the storage and fixed-clock helpers.
 */

import { describe, expect, it } from 'bun:test';

import { Licensing } from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

import { forgeToken } from '../client/_helpers.ts';

const PASSPHRASE = 'test-passphrase-must-be-at-least-32-chars';

describe('Licensing.issuer()', () => {
  it('issues a license with auto-generated key + audit trail', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });

    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_123',
      maxUsages: 5,
    });

    expect(license.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(license.licenseKey).toMatch(/^LIC-/);
    expect(license.raw.licensable_type).toBe('User');
    expect(license.raw.licensable_id).toBe('u_123');
    expect(license.raw.max_usages).toBe(5);
    expect(license.raw.status).toBe('pending');

    // Audit row was written.
    const audit = await db.listAudit({ event: 'license.created' }, { limit: 10 });
    expect(audit.items.length).toBe(1);
    expect(audit.items[0]?.license_id).toBe(license.id);
  });

  it('auto-generates root + signing key on first use; reuses on second issue', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    await issuer.issue({ licensableType: 'User', licensableId: 'a', maxUsages: 1 });
    await issuer.issue({ licensableType: 'User', licensableId: 'b', maxUsages: 1 });

    const keys = await db.listKeys({}, { limit: 10 });
    // One root + one signing.
    expect(keys.items.length).toBe(2);
    const roles = keys.items.map((k) => k.role).sort();
    expect(roles).toEqual(['root', 'signing']);
  });

  it('honours an explicit license_key when provided', async () => {
    const db = new MemoryStorage();
    const issuer = await Licensing.issuer({ db, signing: { passphrase: PASSPHRASE } });
    const license = await issuer.issue({
      licensableType: 'User',
      licensableId: 'u_x',
      maxUsages: 1,
      licenseKey: 'LIC-AAAA-BBBB-CCCC-DDDD-EEEE',
    });
    expect(license.licenseKey).toBe('LIC-AAAA-BBBB-CCCC-DDDD-EEEE');
  });

  it('without `signing` config: throws on first key-requiring operation', async () => {
    const db = new MemoryStorage();
    // Constructor itself does not throw (no eager key resolution).
    const issuer = await Licensing.issuer({ db });
    // …but ensureSigningKey() will, since storage has no key + we have no passphrase.
    await expect(issuer.ensureSigningKey()).rejects.toThrow(/no active signing key/);
  });

  it('throws with non-existent algorithm when `signing.algorithm` is unsupported', async () => {
    const db = new MemoryStorage();
    // 'rs256-pss' isn't in the default backend map; eager makeIssuer should fail.
    await expect(
      Licensing.issuer({
        db,
        signing: { passphrase: PASSPHRASE, algorithm: 'rs256-pss' as const },
      }),
    ).rejects.toThrow();
  });
});

describe('Licensing.client()', () => {
  it('constructs without network access and exposes a token store', () => {
    const client = Licensing.client({
      serverUrl: 'https://license.example.com',
      storage: Licensing.memoryTokenStore(),
    });
    expect(client.tokenStore).toBeDefined();
  });

  // What this can and cannot prove.
  //
  // The POST paths join through joinUrl(), which already collapses a double
  // slash defensively, so removing stripTrailingSlash() does NOT change any
  // URL these tests observe — verified by sabotage. The one caller that
  // concatenates raw is the private health probe (#probeHealth), and it
  // only fires on a grace-entered/continued refresh outcome, which a plain
  // network failure or a 503 does not produce.
  //
  // These tests therefore assert the observable contract — no request ever
  // contains a double slash, with or without a trailing slash on serverUrl
  // — rather than pretending to pin stripTrailingSlash() specifically. The
  // previous version asserted only that construction succeeded, which was
  // weaker still.
  async function urlsHitBy(serverUrl: string): Promise<string[]> {
    const seen: string[] = [];
    // refresh() throws before touching the network when the store is empty,
    // so seed a token that is already due for refresh.
    const store = Licensing.memoryTokenStore();
    const nowSec = Math.floor(Date.now() / 1000);
    const { token } = await forgeToken({ iat: nowSec - 7200, exp: nowSec + 60 });
    await store.write({ token, graceStartedAt: null });
    const client = Licensing.client({
      serverUrl,
      storage: store,
      fetch: (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        seen.push(url);
        // Fail the refresh at the network layer so the health probe runs.
        if (url.includes('/refresh')) throw new TypeError('network down');
        return new Response('{}', { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await client.refresh().catch(() => undefined);
    return seen;
  }

  it('strips a trailing slash so request paths do not double-slash', async () => {
    const urls = await urlsHitBy('https://license.example.com/');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain('.com//');
    }
    expect(urls.some((u) => u.startsWith('https://license.example.com/api/licensing/v1'))).toBe(
      true,
    );
  });

  it('leaves a slash-free serverUrl unchanged', async () => {
    const urls = await urlsHitBy('https://license.example.com');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain('.com//');
    }
  });
});
