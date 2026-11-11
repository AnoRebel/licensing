/**
 * Fail the Nitro server boot if NUXT_SESSION_PASSWORD is missing in
 * production. Runs once at startup — before the first request lands —
 * so a misconfigured deploy crashes loud and fast instead of quietly
 * sealing admin cookies with the dev placeholder.
 *
 * Why a Nitro plugin (not a nuxt.config.ts top-level throw): build-time
 * commands (`nuxt prepare`, `nuxt build`, `nuxt typecheck`) also
 * evaluate the config, and CI runs them without the runtime secret.
 * Gating the check on actual server boot means prod safety doesn't
 * break build pipelines.
 */

export default defineNitroPlugin(() => {
  // Only gate on production. In dev the placeholder in nuxt.config.ts
  // is fine — the password is never persisted to anything external.
  if (process.env.NODE_ENV !== 'production') return;

  const pw = process.env.NUXT_SESSION_PASSWORD;
  if (!pw || pw.length < 32) {
    throw new Error(
      'NUXT_SESSION_PASSWORD is required in production and must be >= 32 chars. ' +
        'Refusing to boot — set the env var or you will seal admin cookies with the dev placeholder.',
    );
  }
});
