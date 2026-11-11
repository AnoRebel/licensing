/**
 * Fail the server boot if NUXT_APP_SECRET is missing in production.
 * Runs once at startup — before the first request lands — so a
 * misconfigured deploy crashes loud and fast. Without it, Nuxt only
 * throws a 500 on the first request that derives the session secret.
 *
 * Why a server plugin (not a nuxt.config.ts top-level throw): build-time
 * commands (`nuxt prepare`, `nuxt build`, `nuxt typecheck`) also
 * evaluate the config, and CI runs them without the runtime secret.
 * Gating the check on actual server boot means prod safety doesn't
 * break build pipelines.
 *
 * A plain function rather than `defineNitroPlugin` so it runs unchanged
 * on Nitro 2 (Nuxt 4) and Nitro 3 (Nuxt 5).
 */

export default () => {
  // Only gate on production. In dev Nuxt generates and persists a secret.
  if (process.env.NODE_ENV !== 'production') return;

  const secret = process.env.NUXT_APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'NUXT_APP_SECRET is required in production and must be >= 32 chars ' +
        '(generate one with `openssl rand -base64 32`). Refusing to boot without a session sealing secret.',
    );
  }
};
