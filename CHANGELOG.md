# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three artefacts are released in lockstep — `@anorebel/licensing` on npm,
`@anorebel/licensing` on jsr.io, and `github.com/AnoRebel/licensing` on
pkg.go.dev. A single entry below describes all three.

## [1.0.0] — 2026-08-21

First stable release. The compatibility promise in
[`docs/versioning.md`](docs/versioning.md) takes effect: the exported API
of both ports, both token wire formats, the OpenAPI contract, the storage
schema, and the default issuance format are covered by semver from here.

### Added

**LIC2 — a second token format.** PASETO `v4.public`, opt-in via
`tokenFormat` (TS) / `TokenFormat` (Go) on `issueToken` and on the client
handler context. LIC1 remains the default and is unchanged; verifiers
accept both formats regardless of which one an issuer emits, so adopting
LIC2 does not invalidate tokens already on devices.

LIC2 is Ed25519-only — PASETO commits to the algorithm in its version
string, so there is no v4 encoding for RSA-PSS. Pairing LIC2 with another
algorithm fails at construction rather than producing an unverifiable
token. PASETO's symmetric `v4.local` mode is deliberately excluded: it
would let any party that can read a token also mint one, which is
incompatible with distributing verification keys to devices.

Implemented directly on the existing runtime-backed Ed25519 backend rather
than via a PASETO dependency, keeping the package's runtime dependency
count at zero. Correctness is pinned three ways: an independent
implementation (`paseto-ts`, a devDependency) verifies tokens this library
produces and vice versa, PAE is checked against the specification's own
vectors in both ports, and committed cross-port fixtures under
`fixtures/tokens-lic2/` byte-compare Go and TypeScript output.

**Token codec registry.** Tokens are routed by prefix to a codec that owns
decoding, encoding, and its own signing-input construction. A token bearing
a registered prefix is never parsed by another format's parser, an
unregistered prefix is rejected before any decoding, and a signature valid
under one format's construction is rejected under another's.

**GitHub Releases.** Every tag now publishes a Release with notes derived
from this changelog, the npm tarball, the Go module zip, and a SHA-256
checksum file. Prereleases are marked as such.

**Transparency hook records the issued format.** `TokenIssuedEvent` carries
`tokenFormat`, so an operator running mixed formats can tell which devices
hold which envelope.

### Fixed

**Token-format assumptions that would have made LIC2 unusable.** Four
separate places assumed LIC1 was the only format:

- The Go device client rejected every LIC2 token — `Validate` and `Peek`
  used LIC1-only entry points, so a device would activate successfully and
  then fail every subsequent call, permanently, unable even to refresh.
- The TypeScript device client had the same symptom via a different
  mechanism: the LIC2 codec was absent from the `@anorebel/licensing/client`
  import graph.
- The Go HTTP server rejected the tokens it had just issued — a
  LIC2-configured deployment would mint a token on `/activate` and refuse
  it on `/refresh`, `/heartbeat`, and `/deactivate`.
- The OpenAPI activate/refresh response pinned the token to a LIC1-only
  regex, so LIC2 responses violated the published contract.

**Release automation.** `release-please` had never cut a release: it
derives its baseline from published GitHub Releases and there were none, so
every proposal was computed from an empty history. Publishing Releases
fixes the baseline; file ownership is now disjoint, with `release-please`
owning `VERSION`, `CHANGELOG.md`, and its manifest, and `version:sync`
owning the derived manifests.

**A `notify-go-proxy` step that had been failing silently since it was
written** — the Go module proxy requires case-escaped paths, and the
unescaped URL returned 404 on every release behind a warning-only fallback.

### Changed

**Documentation.** `docs/token-format.md` §9 is now a specification of LIC2
rather than a plan. `docs/versioning.md` gains the stability policy and
retires the pre-1.0 caveat. `RELEASING.md` documents the automated release
path first, with the manual path as a recovery exception. A new
`docs:check` CI gate fails when a shipped doc names a version other than
the current one.

## [0.2.0] — 2026-08-18

### Added

**License-key rotation.** New `POST /admin/licenses/{id}/rotate-key`
(`RotateLicenseKey` in Go, `rotateLicenseKey` in TS) issues a fresh
license key and revokes every active seat in the same transaction, so a
partially-rotated license cannot exist. Revoked licenses are refused.
The `license.key_rotated` audit row records the seat count but **neither
the old nor the new key** — the log is readable by support staff, and
the key is the secret the rotation exists to protect. `license_key`
remains immutable through `PATCH /admin/licenses/{id}`.

**Audit actor attribution.** `audit_logs` gains `actor_kind`
(`system` | `admin` | `client` | `unknown`) and a nullable `actor_id`,
via migration `0005` across postgres and sqlite in both ports. Both
handlers already authenticated a principal and then discarded it,
hardcoding `actor: "admin"`; a multi-operator deployment could not
attribute an action to a person. The free-form `actor` label is kept
and still required, so existing rows, queries, and the admin UI are
unaffected.

**Seat liveness and inactivity sweep.** Usage rows record last-seen
liveness, and `sweepInactiveUsages` / `SweepInactiveUsages` reclaims
seats that have gone quiet past a configurable window.

**Template hierarchy tree.** The admin template detail view renders the
inheritance chain as nested lists rather than a breadcrumb plus a flat
list, so depth is announced to assistive technology instead of only
being drawn. Standalone templates now say so explicitly.

### Changed

**Trial fingerprint hashing switched to HMAC.** `hashFingerprint` /
`HashFingerprint` now compute `HMAC-SHA256(key: pepper, msg: input)`
instead of `SHA-256(pepper || input)`. The prefix-MAC construction was
length-extendable; HMAC is the correct primitive for a keyed digest.
**This changes every trial fingerprint hash** — `trial_issuances` rows
written by an earlier version will not match hashes computed by this
one, so trial dedupe restarts from empty. Shared fixtures were
regenerated accordingly.

**Default key IDs are no longer time-only.** `defaultMakeKid` derived
the kid from a leading timestamp slice, so keys minted in the same
millisecond collided — 200 generated keys produced 3 distinct kids. The
formula now mixes in the random UUIDv7 segment and matches across ports.

### Fixed

**`Client` rejects a config with no `serverUrl`.** Constructing the
device-side `Client` with the `Issuer`'s shape failed inside a private
URL helper with `undefined is not an object (evaluating 's.endsWith')`,
naming an internal function rather than the missing field. Go's
`easy.NewClient` already rejected an empty `ServerURL`; the ports now
agree. The README gained an `Issuer` vs `Client` comparison — server
versus device, database versus HTTP — because the previous wording
never said that `Client` reaches the issuer over the network.

**Symmetric algorithms are rejected in the key hierarchy.** HMAC keys
can no longer be used where an asymmetric signing key is required.

**Examples and docs.** The TypeScript example printed
`verified.payload.fingerprint`, which is never set (the LIC1 claim is
`usage_fingerprint`), so it always logged `undefined`. Both Go examples
and their README documented `cd golang && go run ./examples/...`; there
is no `golang/` directory. Found by installing the published artefacts
into fresh projects and running the documented commands verbatim.

**Admin UI.** The activity page was missing from the primary nav. The
ad-hoc template card tested a raw prop instead of its coalesced ref, so
it rendered the wrong branch.

### Dependencies

Go and TypeScript dependency trees refreshed, including the **TanStack
Table v8 → v9** migration (admin `DataTable` moved to the
`tableFeatures()` architecture behind a single app-wide feature set).
TypeScript in the admin workspace is held back pending `vue-tsc`
support.

### Added (earlier in this cycle)

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

[Unreleased]: https://github.com/AnoRebel/licensing/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AnoRebel/licensing/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/AnoRebel/licensing/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AnoRebel/licensing/releases/tag/v0.1.0
