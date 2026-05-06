# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three artefacts are released in lockstep — `@anorebel/licensing` on npm,
`@anorebel/licensing` on jsr.io, and `github.com/AnoRebel/licensing` on
pkg.go.dev. A single entry below describes all three.

## [0.3.0-rc.0](https://github.com/AnoRebel/licensing/compare/licensing-v0.2.0-rc.0...licensing-v0.3.0-rc.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* **ts-sdk:** HeartbeatOptions and the high-level Client.heartbeat() input shape drop the licenseKey, fingerprint, runtimeVersion, and nowSec fields. The server's /heartbeat handler reads only the bearer token from the request body and derives identity from the verified token's claims; the four fields were never transmitted to the wire and earlier client versions sent a body shape the server returned 400 BadRequest for.
* **go-sdk:** HeartbeatOptions and easy.HeartbeatInput drop the LicenseKey, Fingerprint, RuntimeVersion, and NowFunc fields. The server's /heartbeat handler reads only the bearer token from the request body and derives identity (license_id, usage_id, fingerprint) from the verified token's claims; the four fields were never transmitted to the wire and earlier client versions sent a body shape the server returned 400 BadRequest for.
* npm consumers must install @anorebel/licensing. No version of @licensing/sdk was ever published, so the break is only visible to pre-release internal consumers.

### Added

* **admin:** add Nuxt 4 admin UI for license-lifecycle ops ([82175da](https://github.com/AnoRebel/licensing/commit/82175dacca4eb46499b1f9d88787d2dd167a9e62))
* **admin:** add shadcn-vue chart wrapper backed by unovis ([fff2ccb](https://github.com/AnoRebel/licensing/commit/fff2ccbd0bc74a0c63625767a1a08798ce8a296b))
* **admin:** bulk actions on licenses + global activity page ([6428eb2](https://github.com/AnoRebel/licensing/commit/6428eb2a37e4a4c681ce43f795d957787f38d6f7))
* **admin:** drill-down rail on license detail (owner, template, audit) ([68bcf6b](https://github.com/AnoRebel/licensing/commit/68bcf6bb972c7e96ac6e5c39f8d48c2675c7e4c2))
* **admin:** expose template inheritance + Issue-from-template ([0af957d](https://github.com/AnoRebel/licensing/commit/0af957dcbabbbf0e447343a9698deb62eff3bf6c))
* **admin:** rewrite dashboard with chart-driven widgets ([d829857](https://github.com/AnoRebel/licensing/commit/d829857537f30d8d386b759671a96ee217615944))
* **admin:** row selection on DataTable with shadcn-vue checkbox ([29f8982](https://github.com/AnoRebel/licensing/commit/29f8982b3c1ddcd3049a7b358fbec1cbb670ac7d))
* **admin:** wcag 2.2 AA accessibility pass across admin UI ([aa4f05d](https://github.com/AnoRebel/licensing/commit/aa4f05d9be92ecf34a4e65e61a98855694326df6))
* **api:** add licensing-admin OpenAPI contract ([bde60a3](https://github.com/AnoRebel/licensing/commit/bde60a3c8b77692272c30f6f9236db346a43ec59))
* **go-sdk:** /admin/stats/licenses handler + storage aggregator ([2f56341](https://github.com/AnoRebel/licensing/commit/2f56341f24368a6743f2558d5e71fafb1093c114))
* **go-sdk:** /health storage probe + client refresh-failure disambiguation ([2460828](https://github.com/AnoRebel/licensing/commit/2460828622b1c081b13e91bb8d5613277c7e4f85))
* **go-sdk:** add Go licensing SDK and licensing-keys CLI ([7b54a32](https://github.com/AnoRebel/licensing/commit/7b54a3228b5806cc0a77233b94bcb5aa520287a8))
* **go-sdk:** admin handlers persist parent_id and trial_cooldown_sec ([e52e9f4](https://github.com/AnoRebel/licensing/commit/e52e9f4262cdd3f58bac5c9229e82e34ba2cbfe0))
* **go-sdk:** client guard lifecycle parity (Validate/Refresh/Guard/Heartbeat) ([6cb8dd2](https://github.com/AnoRebel/licensing/commit/6cb8dd23865399816d8b5568a0ef0f1b7528b69f))
* **go-sdk:** consumer-side license-guard middleware for chi, gin, echo ([9eb906e](https://github.com/AnoRebel/licensing/commit/9eb906ea7adeb42ce6fa57fb566902041758ea5c))
* **go-sdk:** easy.NewIssuer / easy.NewClient high-level factories ([6d366ef](https://github.com/AnoRebel/licensing/commit/6d366ef53b34edc36e4a9b268c680221a8355d03))
* **go-sdk:** heartbeat sends token + auto-clears on revoke ([8b59c31](https://github.com/AnoRebel/licensing/commit/8b59c312fa73fb3a80e87f4538a35eed82c62f10))
* **go-sdk:** issue applies template inheritance + trial dedupe ([8d4d4f2](https://github.com/AnoRebel/licensing/commit/8d4d4f24ab6e8519bcf9d452e12bb922e19fcf57))
* **go-sdk:** jti replay-prevention ledger (opt-in for online verifiers) ([3192d04](https://github.com/AnoRebel/licensing/commit/3192d04f8e7d64eb425209701f1d120b4d86be92))
* **go-sdk:** optional aud + iss claims with verifier-pin enforcement ([e09ed05](https://github.com/AnoRebel/licensing/commit/e09ed05d3c392f28baece30579cb9feeadbd96d3))
* **go-sdk:** sqlite + postgres JtiLedger adapters ([e6d0951](https://github.com/AnoRebel/licensing/commit/e6d0951ccc86e9cbc0fd845060452216fe855a8e))
* **go-sdk:** strict duplicate-key parser at token decode time ([775344f](https://github.com/AnoRebel/licensing/commit/775344fb9d9eed16e5cc5a8b997fe5436eb77983))
* **go-sdk:** template hierarchy + findByLicensable ([550d5a0](https://github.com/AnoRebel/licensing/commit/550d5a02ea3d22bf534ab840939198fae020106e))
* **go-sdk:** transparency hook on token issuance ([0b1c68c](https://github.com/AnoRebel/licensing/commit/0b1c68cba8d09aafd89c86067adb0bc3ab600348))
* **go-sdk:** trial-issuance CRUD + extended audit filter ([80f33f7](https://github.com/AnoRebel/licensing/commit/80f33f796a258af15da437e66517aa421291057e))
* **go-sdk:** v0002 storage migration for templates + trials ([cf1a0ce](https://github.com/AnoRebel/licensing/commit/cf1a0ce85e9443d504fc55088f4186f54a2a3644))
* **openapi:** add /admin/stats/licenses dashboard rollup ([0f07c03](https://github.com/AnoRebel/licensing/commit/0f07c03c8e57d93102684f3085c1d9070a6b2da3))
* **openapi:** add parent_id and trial_cooldown_sec to template CRUD ([14794f2](https://github.com/AnoRebel/licensing/commit/14794f285ec30a475b02b144cfb76d226690ab3d))
* **openapi:** document /health 200 + 503 with status enum and time field ([18fabd7](https://github.com/AnoRebel/licensing/commit/18fabd7a81bb1fd93371107cb4de6bac9877a0ff))
* **schema:** document v0002 schema additions ([f665163](https://github.com/AnoRebel/licensing/commit/f665163a08b28dcdf85a1512999202cc3029ba40))
* **sdk:** add @licensing/sdk TypeScript package ([d133808](https://github.com/AnoRebel/licensing/commit/d133808bf4bad384570d47d2edc42e9bfac672c7))
* **sdk:** expose ./cli export and add test:contract script ([7be3d01](https://github.com/AnoRebel/licensing/commit/7be3d01a705ec497a6a1308a6a882b621de2023f))
* **ts-sdk:** /admin/stats/licenses handler + storage aggregator ([a84459c](https://github.com/AnoRebel/licensing/commit/a84459c5f72c1786831056415525878aeac307c8))
* **ts-sdk:** /health storage probe + client refresh-failure disambiguation ([7696a63](https://github.com/AnoRebel/licensing/commit/7696a63391bc1d75e9bf1de4f72c0570df2ecd8a))
* **ts-sdk:** admin handlers persist parent_id and trial_cooldown_sec ([945fad6](https://github.com/AnoRebel/licensing/commit/945fad67d173a481fdfe05faed1c5d028f5cc1a9))
* **ts-sdk:** client guard lifecycle (validate/refresh/guard/heartbeat) ([02978ad](https://github.com/AnoRebel/licensing/commit/02978adc5a520711e00ab345f40d0f98b0d80ae1))
* **ts-sdk:** consumer-side licenseGuard middleware for express, hono, fastify ([3b50d7a](https://github.com/AnoRebel/licensing/commit/3b50d7a9ba505f275a7cce3614c93d3a935ef481))
* **ts-sdk:** heartbeat sends token + auto-clears on revoke ([c5bb194](https://github.com/AnoRebel/licensing/commit/c5bb194b6e8ac433e3daa53d5bde725b48588ecf))
* **ts-sdk:** high-level Licensing.issuer / Licensing.client factories ([eae7cbf](https://github.com/AnoRebel/licensing/commit/eae7cbfc4300bf8f49635cc8f9add304c3dd748e))
* **ts-sdk:** issuer.issue applies template inheritance + trial dedupe ([08b3e7d](https://github.com/AnoRebel/licensing/commit/08b3e7dcd5ae3305691b79037a8c7e3894cce3c2))
* **ts-sdk:** jti replay-prevention ledger (opt-in for online verifiers) ([d785540](https://github.com/AnoRebel/licensing/commit/d7855409f65d6289f3aeea2363a941cd4356d1b6))
* **ts-sdk:** optional aud + iss claims with verifier-pin enforcement ([07131d4](https://github.com/AnoRebel/licensing/commit/07131d4e59dbf01556f8261a754707235e27c204))
* **ts-sdk:** sqlite + postgres JtiLedger adapters ([281a36e](https://github.com/AnoRebel/licensing/commit/281a36e45a20c6e19b86dc0b63c98d299a3a2e23))
* **ts-sdk:** strict duplicate-key parser at token decode time ([0c2c72e](https://github.com/AnoRebel/licensing/commit/0c2c72ed785d6dbb4be8910db3c9326737e56ac9))
* **ts-sdk:** template hierarchy + findByLicensable ([554943c](https://github.com/AnoRebel/licensing/commit/554943cd8c33effd23385d2a9c7a57982533c20c))
* **ts-sdk:** transparency hook on token issuance ([c364d9c](https://github.com/AnoRebel/licensing/commit/c364d9ccd567c20b11f5f3d37b21e7d0e1138a50))
* **ts-sdk:** trial-issuance CRUD + extended audit filter ([b6b23f6](https://github.com/AnoRebel/licensing/commit/b6b23f6cb0a15f2319a85fee03dedfbc2cd6ab4c))
* **ts-sdk:** v0002 storage migration for templates + trials ([00f41a2](https://github.com/AnoRebel/licensing/commit/00f41a2a5594b6e253dc85349b6383b638c08185))


### Fixed

* **admin:** bump playwright timeouts for chart-cold-compile flake ([a03e225](https://github.com/AnoRebel/licensing/commit/a03e225870af1cbc6ae9a1b89c8ab7e7fe330c75))
* **admin:** bump sign-in caption contrast to full muted-foreground ([54b8cc9](https://github.com/AnoRebel/licensing/commit/54b8cc97326f5136921094c6d46fbd3435e0330e))
* **admin:** harden session cookie + add proxy origin/CSRF check + require session password in prod ([e807d41](https://github.com/AnoRebel/licensing/commit/e807d411e4f62e878d4d986d9ed05ae388b3a08f))
* **admin:** self-host Cabinet Grotesk to unblock CI build ([4301adf](https://github.com/AnoRebel/licensing/commit/4301adfebbb4e4b5fc96070c325eb0284201f75c))
* **admin:** triple-gate the a11y test session endpoint ([c033d7e](https://github.com/AnoRebel/licensing/commit/c033d7eca29bea394b2355361430c70350658d88))
* **ci:** publish prereleases under npm dist-tag 'next' ([99ff0b1](https://github.com/AnoRebel/licensing/commit/99ff0b14bf907324c48f6e9b2d4e2a4e961166d5))
* **go-sdk:** verify client tokens on refresh/heartbeat/deactivate + cap request body ([24748fe](https://github.com/AnoRebel/licensing/commit/24748fe3a84f43dd91e6754f47ea36e927977f4a))
* **license:** use canonical Apache-2.0 text so pkg.go.dev recognises it ([8b3526c](https://github.com/AnoRebel/licensing/commit/8b3526cc9b958cc2ef782a68f42bbf6bf2fee00d))
* **scripts:** drop node:fs/promises glob for Node 20 compatibility ([28c1bb3](https://github.com/AnoRebel/licensing/commit/28c1bb389ddd0fb1ff77acef2805176f8c7b16ef))
* **sdk:** enforce PBES2/PBKDF2-SHA256/AES-256-GCM OID profile on PKCS[#8](https://github.com/AnoRebel/licensing/issues/8) unwrap ([14b24e4](https://github.com/AnoRebel/licensing/commit/14b24e4ef8c1e90aef7ea3573392b9f867619db1))
* **sdk:** verify client tokens on refresh/heartbeat/deactivate ([1660e62](https://github.com/AnoRebel/licensing/commit/1660e6265b0f751874d672681582512142f83dd7))
* **ts-sdk:** add explicit return types to satisfy JSR slow-types ([4a81399](https://github.com/AnoRebel/licensing/commit/4a8139915d22cdc5f183dc69168401eb125ec258))
* **ts:** strip leading ./ from bin path; document tsdown platform choice ([831f26b](https://github.com/AnoRebel/licensing/commit/831f26b646e0c2b9151630f2d7b3afbe7525765d))


### Documentation

* add README, RELEASING, security, token-format, versioning ([e841a33](https://github.com/AnoRebel/licensing/commit/e841a33f22ea6f5da12f15918f30a8a0368bc1cc))
* **admin:** drop README reference to removed axe suite ([5a51f5b](https://github.com/AnoRebel/licensing/commit/5a51f5b84b0c453db87ba149aae66cc501f5c962))
* align release + versioning references with [@anorebel](https://github.com/anorebel) scope ([697750d](https://github.com/AnoRebel/licensing/commit/697750d1b79c57f95d88422e899213b32626f8ec))
* ct-style transparency moves from out-of-scope to opt-in hook ([b0ad915](https://github.com/AnoRebel/licensing/commit/b0ad915f71916a461a97806ee2a13c0f192568a4))
* **docs:** add examples for TS and Go consumers ([a17e251](https://github.com/AnoRebel/licensing/commit/a17e251ac75373f136e8262f95c2ef00b381a6b0))
* document heartbeat-driven revocation push in threat model ([324d28c](https://github.com/AnoRebel/licensing/commit/324d28cb24d39ef473f21821426a25ac22f1484e))
* document OID allowlist, CSRF defence-in-depth, a11y posture, rc suffix ([b213ff0](https://github.com/AnoRebel/licensing/commit/b213ff01ff96572327358a54048adba2044a8310))
* drop internal planning labels from public docs ([e290e8a](https://github.com/AnoRebel/licensing/commit/e290e8a199716707c1d64b1e8e33c7d4fa01e8bf))
* expand verifier-compromise section with deployment escalation paths ([9446c68](https://github.com/AnoRebel/licensing/commit/9446c68bde36f485a9e449385cc4a7f7bbb16446))
* **go:** refresh TS-package refs in doc comments ([f2effb3](https://github.com/AnoRebel/licensing/commit/f2effb3a9f8bdbd426059808595c4702f99678e3))
* log [Unreleased] entries for templates / dashboard / middleware ([76c8d71](https://github.com/AnoRebel/licensing/commit/76c8d71f355084b567e5fb17fe9091d63c84d59f))
* mark duplicate-key parser gap closed in threat model ([9ead741](https://github.com/AnoRebel/licensing/commit/9ead741f5608049329a13accf3369f128fbd3e1b))
* **readme:** add version badges for npm, JSR, and pkg.go.dev ([2de9634](https://github.com/AnoRebel/licensing/commit/2de96341f24ffd45cf49ffdcd762bb416fe91adb))
* **readme:** lead with package capabilities; footnote the clean-room origin ([be22012](https://github.com/AnoRebel/licensing/commit/be22012d12a680bdbb690ddf23850acd5aa3e282))
* redirect KAT references to fixtures/tokens, document determinism per alg ([c4ce7a6](https://github.com/AnoRebel/licensing/commit/c4ce7a64e63d2b99114c4b09ce80156b92325813))
* replay-within-exp moves from out-of-scope to opt-in mitigation ([6a37367](https://github.com/AnoRebel/licensing/commit/6a3736780ad3db11c52828ad6e83912fa900461d))
* rewrite LIC1 spec with accurate claims + add token threat model ([e860018](https://github.com/AnoRebel/licensing/commit/e860018c87f17b1268cb84e4e5f5e9d07cd587d4))
* rewrite quickstart, add templates/trials/integrations + LIC2 plan ([69a94e9](https://github.com/AnoRebel/licensing/commit/69a94e910ff133d7c4cfda34c9d91bda51250a76))


### Chore

* rename TS package @licensing/sdk → @anorebel/licensing ([530a81f](https://github.com/AnoRebel/licensing/commit/530a81f01f26b987a79629eb11946364862f9c98))

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
