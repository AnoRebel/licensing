/**
 * Route guard. Two rules:
 *   1. Any non-sign-in route requires a session — otherwise redirect to
 *      /sign-in with `?next=<original path>` so we can bounce back after
 *      auth succeeds.
 *   2. An authenticated user hitting /sign-in gets sent to the dashboard.
 *      Prevents the awkward "sign in again while already signed in" state.
 *
 * `useUserSession` here reads the unsealed portion of the cookie
 * (user + loggedInAt). The sealed `secure.apiToken` stays server-only.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession();

  if (to.path === '/sign-in') {
    if (loggedIn.value) {
      return navigateTo('/', { replace: true });
    }
    return;
  }

  if (!loggedIn.value) {
    const next = to.fullPath && to.fullPath !== '/' ? to.fullPath : undefined;
    return navigateTo(next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in', {
      replace: true,
    });
  }
});
