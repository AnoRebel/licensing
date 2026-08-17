# @licensing/admin

Nuxt 4 admin console for the licensing platform. Talks to either the Go
(`licensing/http`) or TS (`typescript/src/http`) backend
over the contract defined by `openapi/licensing-admin.yaml`.

## Stack

- Nuxt 4.5 (`future.compatibilityVersion: 5`)
- shadcn-vue via `shadcn-nuxt` + Tailwind v4 (`@tailwindcss/vite`)
- `@tanstack/vue-table` v9 behind a shared `DataTable` — see
  "Adding a list view" below
- `@nuxt/fonts` with both families self-hosted under `public/fonts/`, so
  the build makes no font network calls
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

## Adding a list view

Every list page is the shared `DataTable` plus a column file. You should not
need to read `DataTable.vue` to add one.

**1. Define the columns.** Put them in `app/pages/<resource>/columns.ts` and
type them with `AppColumnDef` (not the library's `ColumnDef` — see
"Table architecture" below):

```ts
import { h } from 'vue';
import type { components } from '#open-fetch-schemas/licensing';
import DataTableColumnHeader from '~/components/DataTable/DataTableColumnHeader.vue';
import type { AppColumnDef } from '~/lib/table';

type Scope = components['schemas']['Scope'];

export const scopeColumns: AppColumnDef<Scope>[] = [
  {
    id: 'slug',
    accessorKey: 'slug',
    // Pass the row type explicitly: h() cannot infer a component's generic.
    header: ({ column }) => h(DataTableColumnHeader<Scope>, { column, title: 'slug' }),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs' }, row.original.slug),
    filterFn: 'includesString',
  },
];
```

**2. Render the table.** In `app/pages/<resource>/index.vue`:

```vue
<DataTable
  :columns="scopeColumns"
  :data="items"
  :loading="pending"
  search-column="slug"
  search-placeholder="Filter by slug…"
  pagination-mode="cursor"
  :next-cursor="nextCursor"
  :can-go-prev="cursorStack.length > 0"
  empty-message="No scopes yet."
  @row-click="(row) => router.push(`/scopes/${(row as Scope).id}`)"
  @prev="goPrev"
  @next="goNext"
/>
```

**Pagination — pick the right mode.** `cursor` is what every current list
view uses: the server owns paging via its `next_cursor` contract, and the
table delegates `@prev`/`@next` to you rather than slicing rows. Use
`client` only when the API returns the whole dataset in one response; then
the table paginates locally and you can drop the cursor props.

**Optional extras**

- **Faceted filters** — pass `:filter-facets="facets"` where `facets` is a
  `FilterFacet[]` (`{ columnId, title, options: { label, value }[] }`). The
  column's `filterFn` must treat the selected array as OR-membership.
- **Row selection** — add `selectable` and listen to `@selection-change`;
  a checkbox column is prepended for you.
- **Free-text search** — `search-column` names the column the toolbar input
  filters. A synthetic `accessorFn` column is the usual way to make several
  fields searchable at once (see `activity.vue`).
- **Hide the toolbar** — `:toolbar="false"` for embedded tables on detail
  pages.

### Table architecture

Features are declared **once for the whole app** in `app/lib/table.ts`, not
per page. TanStack Table v9 parameterises every table type by its feature
set (`Table<TFeatures, TData>`), so if each page registered its own
features, each page's `ColumnDef` would be a structurally different type and
the shared `DataTable` could not accept them. One app-wide set keeps
`TFeatures` a single concrete type — which is why you import `AppColumnDef`,
`AppTable`, `AppRow` and `AppColumn` from `~/lib/table` instead of the
library directly.

Two consequences worth knowing before you fight the compiler:

- **Adding a feature** (grouping, pinning, resizing) means registering it in
  `app/lib/table.ts`, plus its row model if it has one. A column option that
  "should exist" but doesn't typecheck usually means its feature isn't
  registered — `size` needs `columnSizingFeature`, and a string
  `filterFn: 'includesString'` needs that name in the `filterFns` registry.
- **Row types cannot be erased.** v9's `Column` is invariant in `TData` and
  `Column.parent` refers back to itself, so `any`, `unknown`, `RowData` and
  `Record<string, any>` are all rejected where a concrete column is
  expected. That is why the header/facet components stay generic and why
  call sites write `h(DataTableColumnHeader<Row>, …)`.

## Browser smoke checks

A small [bunwright](https://github.com/jonaspm/bunwright) suite drives the
list views in a real browser, because a green typecheck cannot tell you that
sorting still sorts.

```bash
bun run build                                        # the suite drives .output/
BUN_CHROME_PATH=/usr/bin/helium-browser bun run test:smoke
```

`BUN_CHROME_PATH` is optional — without it the harness looks for
`helium-browser`, `brave`, `chromium`, then `google-chrome` in `/usr/bin`.
No browser is ever downloaded; if none is found the run fails immediately
with a message naming the variable to set.

What it covers: every list view renders rows with no uncaught page errors,
sorting reorders rows, the free-text filter narrows them, and hiding a
column removes it. On the dashboard, all four widgets render, and a single
failing upstream endpoint degrades **only its own widget** while the others
keep their data. Assertions read rendered DOM — row text, counts, and
widget body text — never component internals.

Widget assertions deliberately read the widget's *body*, not its heading:
headings render from static markup whether or not the fetch succeeded, so a
heading-only check passes even with every endpoint down.

Each file runs in its own `bun test` process (`tests/smoke/run.ts`).
bunwright's `browser` is a module-level singleton, and Bun runs test files
concurrently in one process — so two files share one browser and the first
`afterAll` closes it out from under the second. Symptom: each file passes
alone, they fail together.

The upstream API is stubbed, and the payloads are **generated from
`openapi/licensing-admin.yaml`** (`tests/smoke/openapi-fixtures.ts`) rather
than hand-written, so a newly-required property cannot silently go missing
from the fixtures. Only the upstream is swapped: the run still exercises the
real Nuxt app, the real `/api/proxy/*` layer and session cookie, and the
real generated client. Contract drift against a real backend is covered by
the `openapi-contract` and `interop` CI jobs.

Two things worth knowing before extending the suite:

- bunwright resolves each selector as a **single** expression — comma
  separated fallbacks are invalid CSS and will throw.
- `text:Foo` requires an **exact** `textContent.trim()` match, so it misses
  menu items that also contain an icon. Prefer `css:` with `:first-child` /
  `:last-child` (not `:nth-of-type`, which counts by tag — every menu child
  here is a `div`, including separators).

In CI the job is **non-blocking** while bunwright is pre-1.0; the promotion
criteria are recorded in `.github/workflows/admin-ui.yml`.

## Linting

Two tools, **no overlap** — they cover disjoint file sets:

| Tool     | Owns                                   | Command             |
| -------- | -------------------------------------- | ------------------- |
| `biome`  | `.ts` / `.mjs` / `.json` + all formatting | `bunx biome check .` |
| `eslint` | `.vue` SFCs (Vue/Nuxt rules)           | `bun run lint`      |

`biome.json` excludes `admin/**/*.vue` explicitly, because Biome has no Vue
SFC parser. Without ESLint the ~120 components here would be linted by
nothing at all, so both must pass. No file is checked by both tools, and
Biome remains the only formatter — do not add ESLint formatting rules.

`eslint` is declared directly in `devDependencies` even though it arrives as
a peer of `@nuxt/eslint`: bun links no binary for an undeclared peer, and
`bun run lint` fails with `eslint: command not found` without it.

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
