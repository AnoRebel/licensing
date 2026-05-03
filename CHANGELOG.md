# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three artefacts are released in lockstep — `@anorebel/licensing` on npm,
`@anorebel/licensing` on jsr.io, and `github.com/AnoRebel/licensing` on
pkg.go.dev. A single entry below describes all three.

## [Unreleased]

### Added

**Templates / inheritance / trials.** `license_templates.parent_id`
and `license_templates.trial_cooldown_sec` are now first-class on
the OpenAPI request bodies, every storage adapter, and the admin
UI. Trial issuance via `Issuer.issue({ isTrial: true })` /
`easy.Issuer.Issue(IsTrial: true)` records a peppered
`(template_id, fingerprint_hash)` row in `trial_issuances` and
rejects re-issues inside the cooldown window with
`TrialAlreadyIssued`. Template inheritance walks up to five
ancestors with child-wins precedence and surfaces the chain in the
admin UI's hierarchy preview. `TemplateCycle` is rejected at write
time and surfaces as **409 Conflict** in both ports.

**Aggregate dashboard rollup.** New `GET /admin/stats/licenses`
endpoint with optional `scope_id` filter. Returns counts per
status, expiring-within-30d, a 30-day audit-derived
`{added, removed}` delta, seat-utilisation totals + top-10, and
top-10 templates by license count. Implementation lives in a
shared `computeLicenseStats` aggregator in both ports so the
memory / sqlite / postgres adapters return byte-identical output;
cross-port byte parity is verified by the contract suite.

**Framework middleware adapters.** Three TS (Express 5, Hono 4,
Fastify 5) and three Go (chi v5, gin, echo v5) ship under
`@anorebel/licensing/middleware/<framework>` and
`github.com/AnoRebel/licensing/licensing/middleware/<framework>`.
Each adapter is a thin shim over a shared core that emits the
canonical `(status, body)` shape; the cross-framework matrix tests
in CI guarantee byte-identical responses for every scenario.

**Admin UI.** Dashboard rebuilt as four widgets each owning their
own data fetch (failure isolation): license overview tiles + a
status-mix donut, expiring-within-30d list with a 30-bar histogram,
recent activations with a 24h sparkline + 60s polling
(prefers-reduced-motion respected), seat-utilisation horizontal
bars with ok / warn / alert thresholds. Charts are powered by
`@unovis/vue` wrapped in shadcn-vue chart components; the chart
container retints between light + dark mode via the existing CSS
tokens. New license drill-down rail (owner card via consumer-
provided `/owners/{type}/{id}` resolver, template card linking to
`/templates/{id}`, audit timeline grouped by day with payload
expanders). Bulk actions on the licenses index (Revoke / Suspend /
Unsuspend / Extend expiry by N days) with mixed-status partitioning
and confirmation copy that names the affected count. New
`/activity` global event stream with chip-row event filter and
DataTable-driven free-text search.

**Documentation.** Root README quickstart rewritten around the
high-level `Issuer` / `easy.Issuer` API (5-line examples per
port). New `docs/templates.md` (flat templates → hierarchy →
inheritance precedence → cycle detection), `docs/trials.md`
(server-issued trials, fingerprint dedupe, pepper threat model,
admin reset workflow), and `docs/framework-integrations.md` (one
recipe per adapter). `docs/token-format.md` gains a "LIC2 (planned)"
section with a decision matrix for callers weighing LIC1 today vs
LIC2 later.

### Changed

**Admin DataTable.** Gains a `selectable` prop that prepends a
checkbox column with header tri-state, emits `selectionChange` with
the array of row originals, and resets selection when the
underlying dataset changes. Used by the new bulk-actions flow on
the licenses index.

**Errors.** `TemplateCycle` now maps to **409 Conflict** in the Go
HTTP layer (TS port already did). The adapter-layer error map and
both the OpenAPI spec (`POST /admin/templates`,
`PATCH /admin/templates/{id}`) declare the response so consumers
can surface it specifically.

### BREAKING

**Heartbeat options.** TS `HeartbeatOptions` and Go
`HeartbeatOptions` no longer accept `licenseKey`, `fingerprint`,
`runtimeVersion`, or `nowFunc` — those fields were defaults
inferred from the bound `Client` and never actually consumed by
downstream code. Callers should drop them.

## [0.1.0-rc.0] — 2026-04-21

Initial public release candidate. Clean-room TS + Go port of
[`masterix21/laravel-licensing`](https://github.com/masterix21/laravel-licensing)
with a framework-agnostic admin UI (Nuxt 4 + shadcn-nuxt).

### Added

**Token format (LIC1).** Prefix-based dispatch (`LIC1.` header), canonical
JSON body, ed25519 / RSA-PSS / HMAC-SHA-256 signature algorithms. Byte-identical
serialization across both ports, enforced by a 10 000-case property test.

**TypeScript — `@anorebel/licensing`.** Single package with subpath exports
mirroring the Go module layout 1:1: `/crypto/{ed25519,rsa,hmac}`, `/client`,
`/http` + `/http/adapters/{hono,express,fastify,node}`, `/storage/{memory,postgres,sqlite}`,
`/cli`. Published to both npm (dual ESM/CJS via `tsdown`) and jsr.io (raw
TypeScript). `pg`, `hono`, `express`, `fastify` declared as optional peer
dependencies.

**Go — `github.com/AnoRebel/licensing`.** `licensing/`, `licensing/client/`,
`licensing/crypto/{ed25519,rsa,hmac}/`, `licensing/http/`,
`licensing/storage/{memory,postgres,sqlite}/`, `cmd/licensing-keys/`. Pure
stdlib crypto. Zero required dependencies on the core path; pgx only for the
Postgres adapter, modernc.org/sqlite only for SQLite.

**Issuer features.** License lifecycle state machine (activate/suspend/resume/
revoke/expire/renew + grace window), seat enforcement inside transactions,
LicenseScope + LicenseTemplate, key hierarchy with root ↔ signing rotation,
encrypted-at-rest PKCS#8 (PBES2 + AES-256-GCM). Append-only AuditLog enforced
at both the API surface and SQL trigger layer.

**Client features.** Offline `validate()`, `activate()`, `refresh()`,
heartbeat scheduler, grace-on-unreachable, `deactivate()`, device fingerprint
derivation. 15-row transition table proves TS and Go clients return
byte-identical decisions on every corner case.

**HTTP reference handlers.** Framework-agnostic core; optional adapters for
Hono, Express, Fastify, and Node stdlib (TS) and a stdlib `http.Handler` base
(Go). Bearer-token auth with pluggable verifier. Rate limiter (token bucket,
per-IP default, configurable key function, RFC 7235 token68 charset).

**Admin UI.** Nuxt 4 + shadcn-nuxt dashboard. Typed OpenAPI client via
nuxt-open-fetch, sealed-cookie sessions via nuxt-auth-utils, dark mode,
WCAG 2.2 AA accessibility (axe-core in CI). Licenses / Scopes / Templates /
Usages / Keys / Audit resources.

**Interop CI.** Every fixture token is signed by one port and verified by the
other (24 × 2 directions = 48 round-trips per run). Canonical-JSON property
test (10 000 random payloads). Grace-period transition-table test.

**Versioning & distribution.** Single `VERSION` file drives every manifest.
`scripts/sync-versions.mjs` keeps `package.json`, `jsr.json`, workspace
manifests, and `licensing/version.go` in lockstep. `bun run
version:check` is a CI gate against drift.

### Security

Ed25519 default, RSA-PSS SHA-256 alternate (min 2048-bit enforced on import),
HMAC-SHA-256 alternate (min 32-byte secret enforced on import). Algorithm
binding per `kid` prevents alg-confusion attacks — validators refuse a token
whose `alg` doesn't match what's registered for its `kid`. CLI refuses empty
passphrases and never accepts passphrases via argv.

### Known limitations

- **SQLite.** TS uses `bun:sqlite` — requires Bun at runtime for apps that
  consume the SQLite adapter.
- **No PASETO support.** LIC1 is the only token format. PASETO compatibility
  (hypothetical `LIC2`) is an anticipated future release; the dispatch
  registry leaves the path open without shipping any PASETO code today.

[Unreleased]: https://github.com/AnoRebel/licensing/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AnoRebel/licensing/releases/tag/v0.1.0
