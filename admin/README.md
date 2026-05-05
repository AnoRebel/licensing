# @licensing/admin

Nuxt 4 admin console for the licensing platform. Talks to either the Go
(`licensing/http`) or TS (`typescript/src/http`) backend
over the contract defined by `openapi/licensing-admin.yaml`.

## Stack

- Nuxt 4.4 (`future.compatibilityVersion: 5`)
- shadcn-vue via `shadcn-nuxt` + Tailwind v4 (`@tailwindcss/vite`)
- `nuxt-open-fetch` — regenerates a typed `useLicensing()` composable from
  the committed OpenAPI yaml on every build, so client types never drift
- `@nuxtjs/color-mode` wired for shadcn dark mode (`classSuffix: ''`)
- `@vueuse/nuxt` for auto-imported composables

## Dev

```bash
bun install
bun run --filter @licensing/admin dev
```

Build:

```bash
bun run --filter @licensing/admin build
```

## OpenAPI

The typed client comes from `../openapi/licensing-admin.yaml`. There is no
committed artefact — `nuxt-open-fetch` regenerates every build, so edits to
the yaml are picked up automatically. No drift check needed.

## Accessibility

Target is WCAG 2.2 AA. The UI is designed against both light and dark
themes; `prefers-reduced-motion: reduce` collapses every transition and
animation to a single frame (see `assets/css/tailwind.css`). Manual
keyboard walkthroughs are recorded in `docs/a11y-walkthrough.md`; re-run
those when refactoring a primary flow.

## Security posture

The admin UI never holds the upstream bearer token in the browser. See
[`../docs/security.md`](../docs/security.md) for the full threat model —
in short: bearer lives in a sealed httpOnly session cookie
(`nuxt-auth-utils` + iron-webcrypto), and every API call goes through
`server/api/proxy/[...]` which enforces `Sec-Fetch-Site` / `Origin`
same-origin on state-changing methods as CSRF defence-in-depth.

`NUXT_SESSION_PASSWORD` MUST be set in production (≥ 32 bytes). The dev
fallback fails the server boot when `NODE_ENV=production`.
