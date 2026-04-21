/**
 * Shape augmentations for nuxt-auth-utils. The module types `user` and
 * `secure` as `Record<string, unknown>` by default — declaring fields
 * here tells TS what we store. `secure` is **server-only**; anything in
 * this block must never be read from a client component.
 */

declare module '#auth-utils' {
  interface User {
    id: string;
    email: string;
    name?: string;
  }

  interface UserSession {
    loggedInAt: number;
  }

  interface SecureSessionData {
    /** Bearer token forwarded to the upstream licensing API. */
    apiToken: string;
  }
}

export {};
