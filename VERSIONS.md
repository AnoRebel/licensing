# Pinned toolchain & dependency versions

This file is the single source of truth for the versions this repo targets.
Every pin below is **exact** — no ranges. Bumps go through a change proposal
under `openspec/changes/`.

Last reviewed: 2026-04-12.

## Runtime & build toolchain

| Tool                | Version     | Notes                                                              |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| Bun                 | `1.3.12`    | Pinned via `packageManager` in root `package.json`.                |
| Node (engine floor) | `>=20`      | Used only for tooling that still shells Node; Bun is the runtime.  |
| Go toolchain        | `1.26.1`    | Matches `go.mod` `go` directive; golangci-lint v2 floor is `1.26`. |
| golangci-lint       | `2.11.4`    | v2 schema (see `.golangci.yml`).                                   |
| gofmt / goimports   | bundled     | gofmt ships with Go; goimports via golangci-lint v2 formatters.    |

## TypeScript dev dependencies

Exact pins, declared in the root `package.json` under `devDependencies`:

| Package            | Version   | Role                                             |
| ------------------ | --------- | ------------------------------------------------ |
| `@biomejs/biome`   | `2.4.11`  | Formatter + linter for TS, JSON, Vue.            |
| `@types/node`      | `25.6.0`  | Node typings for shared modules.                 |
| `lefthook`         | `2.1.5`   | Git hook runner; installed via `lefthook install`. |
| `tsdown`           | `0.21.7`  | Dual ESM/CJS bundler with `.d.ts` emission.      |
| `typescript`       | `6.0.2`   | Type checker + language service.                 |

## Per-package TypeScript runtime deps (landing in phases 3–7)

| Package                       | Version   | Used by                                     |
| ----------------------------- | --------- | ------------------------------------------- |
| `pg`                          | `8.13.1`  | `@anorebel/licensing/storage/postgres`.              |
| `@types/pg`                   | `8.11.10` | `@anorebel/licensing/storage/postgres` (dev).        |
| `hono`                        | `5.0.4`   | optional adapter in `@anorebel/licensing/http`. |
| `express`                     | `5.2.1`   | optional adapter in `@anorebel/licensing/http`. |
| `fastify`                     | `5.5.0`   | optional adapter in `@anorebel/licensing/http`. |

## Admin UI (landing in phase 13)

| Package                      | Version      | Notes                                          |
| ---------------------------- | ------------ | ---------------------------------------------- |
| Nuxt                         | `4.2.1`      | Nuxt 4 major line.                             |
| `shadcn-nuxt`                | `2.3.1`      | shadcn-vue integration module for Nuxt 4.      |
| `shadcn-vue` (CLI)           | `2.3.1`      | Component fetcher; kept in sync with `shadcn-nuxt`. |
| `tailwindcss`                | `4.2.0`      | Tailwind v4; CSS-first config per shadcn-vue v2. |
| `@nuxt/icon`                 | `2.2.2`      | Icon module required by shadcn-vue components. |
| `axe-core`                   | `4.12.0`     | Accessibility CI check.                        |

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
