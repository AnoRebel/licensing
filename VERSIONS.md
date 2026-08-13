# Pinned toolchain & dependency versions

This file is the single source of truth for the versions this repo targets.
Every pin below is **exact** — no ranges. Bumps are reviewed deliberately;
edit this file alongside the dependency change in the same commit.

Last reviewed: 2026-08-13.

## Runtime & build toolchain

| Tool                | Version     | Notes                                                              |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| Bun                 | `1.3.14`    | Pinned via `packageManager` in root `package.json`.                |
| Node (engine floor) | `>=22`      | Used only for tooling that still shells Node; Bun is the runtime.  |
| Go toolchain        | `1.26.1`    | Matches `go.mod` `go` directive; golangci-lint v2 floor is `1.26`. |
| golangci-lint       | `2.11.4`    | v2 schema (see `.golangci.yml`).                                   |
| gofmt / goimports   | bundled     | gofmt ships with Go; goimports via golangci-lint v2 formatters.    |

## TypeScript dev dependencies

Exact pins, declared in the root `package.json` under `devDependencies`:

| Package            | Version   | Role                                             |
| ------------------ | --------- | ------------------------------------------------ |
| `@biomejs/biome`   | `2.5.8`   | Formatter + linter for TS, JSON, Vue.            |
| `@types/node`      | `26.2.0`  | Node typings for shared modules.                 |
| `lefthook`         | `2.1.10`  | Git hook runner; installed via `lefthook install`. |
| `tsdown`           | `0.22.14` | Dual ESM/CJS bundler with `.d.ts` emission.      |
| `typescript`       | `7.0.2`   | Type checker + language service. **See the holdback note below — `admin/` is deliberately behind.** |

### Held-back pins

A dependency is only held below its latest stable release when upgrading
would break a build or check we cannot ourselves fix. Each holdback records
the blocker and the condition that lifts it, so it is not carried forward
silently once the blocker clears.

| Package                   | Held at   | Latest | Blocker                                                            | Lift when                                        |
| ------------------------- | --------- | ------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| `typescript` (in `admin/`) | `6.0.3`  | `7.0.2` | `vue-tsc` does not support TypeScript 7, so `admin/` cannot typecheck on it. Root and `typescript/` are already on 7.0.2. | `vue-tsc` ships TypeScript 7 support; then align `admin/` with the root pin and drop this row. |

## Per-package TypeScript runtime deps

Declared in `typescript/package.json` under `devDependencies`; consumers get
them as optional peers.

| Package                       | Version    | Used by                                     |
| ----------------------------- | ---------- | ------------------------------------------- |
| `pg`                          | `^8.23.0`  | `@anorebel/licensing/storage/postgres`.              |
| `@types/pg`                   | `^8.21.0`  | `@anorebel/licensing/storage/postgres` (dev).        |
| `hono`                        | `^4.13.1`  | optional adapter in `@anorebel/licensing/http`. |
| `express`                     | `^5.2.1`   | optional adapter in `@anorebel/licensing/http`. |
| `fastify`                     | `^5.11.3`  | optional adapter in `@anorebel/licensing/http`. |

## Admin UI

| Package                      | Version      | Notes                                          |
| ---------------------------- | ------------ | ---------------------------------------------- |
| Nuxt                         | `4.5.2`      | Nuxt 4 major line.                             |
| `vue`                        | `3.5.41`     | Pinned exactly; `vue-router` tracks at `5.2.0`. |
| `shadcn-nuxt`                | `2.8.2`      | shadcn-vue integration module for Nuxt 4.      |
| `tailwindcss`                | `4.3.3`      | Tailwind v4; CSS-first config per shadcn-vue v2. |
| `@tanstack/vue-table`        | `^9.1.2`     | Headless table behind every list view. v9 registers features explicitly — see `admin/app/lib/table.ts`. |
| `@nuxt/fonts`                | `0.14.0`     | Both families are self-hosted via the `local` provider; the build makes no font network calls. |
| `typescript`                 | `6.0.3`      | **Held back** — see the holdback table above.  |
| `vue-tsc`                    | `^3.3.9`     | Typechecks `.vue` SFCs; gates the TypeScript pin. |
| `@nuxt/eslint` + `eslint`    | `1.17.0` / `10.2.1` | `eslint` is a peer of `@nuxt/eslint` and must be declared directly, or bun links no binary and `bun run lint` fails. |
| `bunwright`                  | `^0.3.2`     | Browser smoke checks. Pre-1.0; no fixtures/workers/trace viewer. |

## Go module dependencies (landing in phases 8–11)

| Module                     | Version     | Used by                                                |
| -------------------------- | ----------- | ------------------------------------------------------ |
| `github.com/jackc/pgx/v5`  | `v5.8.2`    | `licensing/storage/postgres`.                          |
| `modernc.org/sqlite`       | `v1.39.0`   | `licensing/storage/sqlite` (pure-Go; no cgo).          |
| `github.com/labstack/echo/v5` | `v5.1.0` | optional middleware example in `licensing/http`.       |
| `github.com/go-chi/chi/v5` | `v5.2.1`    | optional middleware example in `licensing/http`.       |

## CI & contract tooling

| Tool                                 | Version    | Role                                          |
| ------------------------------------ | ---------- | --------------------------------------------- |
| Spectral (`@stoplight/spectral-cli`) | `6.15.0`   | OpenAPI linting in `openapi-contract.yml`.    |
| `actions/checkout`                   | `v6.0.2`   | GitHub Actions step; pinned to tag (`@v6`).   |
| `actions/setup-go`                   | `v6.4.0`   | GitHub Actions step; pinned to tag (`@v6`).   |
| `actions/setup-node`                 | `v6.3.0`   | GitHub Actions step; used for tooling-only jobs (`@v6`). |
| `oven-sh/setup-bun`                  | `v2.2.0`   | GitHub Actions step; pinned to tag (`@v2`).   |
| `golangci/golangci-lint-action`      | `v9.2.0`   | GitHub Actions step; pairs with v2 linter (`@v9`). |
| `actions/upload-artifact`            | `v7.0.1`   | GitHub Actions step; pinned to tag (`@v7`).   |
| `actions/cache`                      | `v5.0.4`   | GitHub Actions step; pinned to tag (`@v5`).   |

## Conventions

- **Exact pins only.** No `^`, `~`, or ranges in `package.json` dependencies.
  `bun install` is expected to produce a `bun.lock` whose top-level resolutions
  match this table exactly.
- **Go:** `go.mod` pins via `go get <mod>@<exact-version>`; renovate would be
  configured to open a PR per bump, never a range.
- **Bumps:** land in a dedicated change proposal that updates this file, the
  relevant `package.json` / `go.mod`, and the CI workflows in lockstep.
