import * as v from 'valibot';

/**
 * Sign-in form schema — shared between the UI (TanStack Form validators)
 * and the `/api/auth/sign-in` server route. A single schema so client-side
 * validation messages line up exactly with what the server enforces.
 *
 * `token` is intentionally minimal: we don't assume a prefix or length
 * because the UI is auth-scheme-agnostic (licensing-admin-ui spec: operator
 * supplies whatever bearer their issuer issues — API key, PAT, OIDC, etc.).
 */
export const SignInSchema = v.object({
  token: v.pipe(
    v.string('Token must be a string.'),
    v.trim(),
    v.minLength(1, 'Token is required.'),
    v.maxLength(4096, 'Token looks too long — paste just the bearer, not the whole cURL.'),
  ),
});

export type SignInInput = v.InferInput<typeof SignInSchema>;
export type SignInOutput = v.InferOutput<typeof SignInSchema>;
