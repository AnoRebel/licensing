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
