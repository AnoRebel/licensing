/**
 * Terminate the admin session: server clears the sealed cookie, we refresh
 * the client session state so `loggedIn` flips to false, then route to
 * /sign-in. Kept as a composable (not an inline call) so every UI surface
 * that ships a sign-out button does the exact same thing — one place to fix
 * if the order or redirect target ever changes.
 */
export function useSignOut() {
  const { fetch: refreshSession } = useUserSession();

  return async () => {
    try {
      await $fetch('/api/auth/sign-out', { method: 'POST' });
    } finally {
      // Even if the network call fails (offline, upstream down), we still
      // want the client to forget the session — otherwise the user is
      // stuck on an authed screen that can't actually talk to the API.
      await refreshSession();
      await navigateTo('/sign-in', { replace: true });
    }
  };
}
