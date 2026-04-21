/**
 * Test-only endpoint that seals a fixed admin session so Playwright's
 * axe harness can skip the real sign-in flow.
 *
 * Gated on `ADMIN_A11Y_TEST_MODE=1`. The flag is only set by
 * `playwright.config.ts` when booting the Nuxt server for axe runs —
 * in any other environment (dev, staging, prod) this handler 404s and
 * the file is effectively dead code.
 *
 * Why a dedicated endpoint and not `sealSession` in the fixture:
 *   - nuxt-auth-utils encrypts the session cookie with the runtime's
 *     `NUXT_SESSION_PASSWORD`. Duplicating the seal in the test process
 *     means two codepaths have to agree on iron-webcrypto's key
 *     derivation forever. One endpoint, one source of truth.
 *   - Keeps the fixture trivial (`POST /api/__test__/seal-session`)
 *     and the secret never leaves the server process.
 */
export default defineEventHandler(async (event) => {
  if (process.env.ADMIN_A11Y_TEST_MODE !== '1') {
    throw createError({ statusCode: 404, statusMessage: 'not found' });
  }

  await setUserSession(event, {
    user: {
      id: 'axe-fixture-user',
      email: 'axe@licensing.test',
    },
    secure: { apiToken: 'axe-fixture-token' },
    loggedInAt: Date.now(),
  });

  return { ok: true };
});
