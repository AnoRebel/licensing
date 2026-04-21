/**
 * Client example: activate → heartbeat → refresh → deactivate.
 *
 * Uses a mocked `fetch` so the example runs offline. Replace `mockFetch`
 * with `globalThis.fetch` pointed at your issuer to run it for real.
 *
 * Run: bun run examples/ts/client-flow.ts
 */

import {
  activate,
  deactivate,
  MemoryTokenStore,
  refresh,
  sendOneHeartbeat,
} from '@anorebel/licensing/client';

// --- Mock transport ---------------------------------------------------------
//
// The issuer envelope is `{ success: true, data: {...} }` on success and
// `{ success: false, error: { code, message } }` on failure. The client's
// transport layer unwraps `data` and throws a typed error on `error`.

const FAKE_TOKEN =
  'LIC1.eyJ2IjoxLCJ0eXAiOiJsaWMiLCJhbGciOiJlZDI1NTE5Iiwia2lkIjoiazEifQ' +
  '.eyJqdGkiOiJleGFtcGxlIiwiaWF0IjoxNzYwODc4MDAwLCJleHAiOjk5OTk5OTk5OTl9.sig';

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const mockFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.endsWith('/v1/activate')) {
    return ok({ token: FAKE_TOKEN, license_id: 'lic_01HX', usage_id: 'usg_01HX' });
  }
  if (url.endsWith('/v1/refresh')) {
    return ok({ token: FAKE_TOKEN, exp: 9999999999 });
  }
  if (url.endsWith('/v1/heartbeat')) {
    return ok({ ok: true });
  }
  if (url.endsWith('/v1/deactivate')) {
    return ok({ deactivated: true });
  }

  return new Response(
    JSON.stringify({ success: false, error: { code: 'NotFound', message: 'not found' } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
};

// --- Flow -------------------------------------------------------------------

async function main() {
  const store = new MemoryTokenStore();

  const baseUrl = 'https://licensing.example.com';
  const fingerprint = 'b'.repeat(64);
  const licenseKey = 'LK-DEMO-0000-0000';

  // 1. Activate — first run, exchange license key for a token.
  const activated = await activate(licenseKey, {
    baseUrl,
    fingerprint,
    store,
    fetchImpl: mockFetch,
  });
  console.log('Activated:', { license: activated.license_id, usage: activated.usage_id });

  // 2. Inspect the cached token.
  const cached = await store.read();
  console.log('Cached token present:', cached.token !== null);

  // 3. Heartbeat — signals liveness; returns `true` on success, `false`
  //    on failure (errors surface via `onError`).
  const heartbeatOk = await sendOneHeartbeat({
    baseUrl,
    store,
    licenseKey,
    fingerprint,
    runtimeVersion: '0.1.0',
    fetchImpl: mockFetch,
    onError: (err) => console.error('heartbeat err:', err.message),
  });
  console.log('Heartbeat OK:', heartbeatOk);

  // 4. Refresh — rotates the token when past the proactive threshold.
  //    Skipped here: `refresh` peeks the cached token's claims (nbf, exp,
  //    iat) to decide whether a network call is due, and our FAKE_TOKEN
  //    is a placeholder without a real claim set. A real flow stores a
  //    LIC1 token minted by the issuer, and this call would inspect its
  //    `exp` before optionally calling the server.
  void refresh;
  console.log('Refresh path: (skipped — needs a real LIC1 token in the cache)');

  // 5. Deactivate — releases the seat server-side, clears local store.
  await deactivate('user requested', {
    baseUrl,
    store,
    licenseKey,
    fingerprint,
    fetchImpl: mockFetch,
  });
  const after = await store.read();
  console.log('Deactivated; store cleared:', after.token === null);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
