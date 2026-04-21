/**
 * Clear the admin session. Cookie is wiped — the sealed `apiToken` is
 * unrecoverable after this call, which is the whole point.
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event);
  return { ok: true };
});
