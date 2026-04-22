# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three artefacts are released in lockstep — `@anorebel/licensing` on npm,
`@anorebel/licensing` on jsr.io, and `github.com/AnoRebel/licensing` on
pkg.go.dev. A single entry below describes all three.

## [0.2.0-rc.0](https://github.com/AnoRebel/licensing/compare/licensing-v0.1.0-rc.0...licensing-v0.2.0-rc.0) (2026-04-22)


### ⚠ BREAKING CHANGES

* npm consumers must install @anorebel/licensing. No version of @licensing/sdk was ever published, so the break is only visible to pre-release internal consumers.

### Added

* **admin:** add Nuxt 4 admin UI for license-lifecycle ops ([82175da](https://github.com/AnoRebel/licensing/commit/82175dacca4eb46499b1f9d88787d2dd167a9e62))
* **admin:** wcag 2.2 AA accessibility pass across admin UI ([aa4f05d](https://github.com/AnoRebel/licensing/commit/aa4f05d9be92ecf34a4e65e61a98855694326df6))
* **api:** add licensing-admin OpenAPI contract ([bde60a3](https://github.com/AnoRebel/licensing/commit/bde60a3c8b77692272c30f6f9236db346a43ec59))
* **go-sdk:** add Go licensing SDK and licensing-keys CLI ([7b54a32](https://github.com/AnoRebel/licensing/commit/7b54a3228b5806cc0a77233b94bcb5aa520287a8))
* **sdk:** add @licensing/sdk TypeScript package ([d133808](https://github.com/AnoRebel/licensing/commit/d133808bf4bad384570d47d2edc42e9bfac672c7))
* **sdk:** expose ./cli export and add test:contract script ([7be3d01](https://github.com/AnoRebel/licensing/commit/7be3d01a705ec497a6a1308a6a882b621de2023f))


### Fixed

* **admin:** harden session cookie + add proxy origin/CSRF check + require session password in prod ([e807d41](https://github.com/AnoRebel/licensing/commit/e807d411e4f62e878d4d986d9ed05ae388b3a08f))
* **admin:** triple-gate the a11y test session endpoint ([c033d7e](https://github.com/AnoRebel/licensing/commit/c033d7eca29bea394b2355361430c70350658d88))
* **go-sdk:** verify client tokens on refresh/heartbeat/deactivate + cap request body ([24748fe](https://github.com/AnoRebel/licensing/commit/24748fe3a84f43dd91e6754f47ea36e927977f4a))
* **scripts:** drop node:fs/promises glob for Node 20 compatibility ([28c1bb3](https://github.com/AnoRebel/licensing/commit/28c1bb389ddd0fb1ff77acef2805176f8c7b16ef))
* **sdk:** enforce PBES2/PBKDF2-SHA256/AES-256-GCM OID profile on PKCS[#8](https://github.com/AnoRebel/licensing/issues/8) unwrap ([14b24e4](https://github.com/AnoRebel/licensing/commit/14b24e4ef8c1e90aef7ea3573392b9f867619db1))
* **sdk:** verify client tokens on refresh/heartbeat/deactivate ([1660e62](https://github.com/AnoRebel/licensing/commit/1660e6265b0f751874d672681582512142f83dd7))
* **ts:** strip leading ./ from bin path; document tsdown platform choice ([831f26b](https://github.com/AnoRebel/licensing/commit/831f26b646e0c2b9151630f2d7b3afbe7525765d))


### Documentation

* add README, RELEASING, security, token-format, versioning ([e841a33](https://github.com/AnoRebel/licensing/commit/e841a33f22ea6f5da12f15918f30a8a0368bc1cc))
* align release + versioning references with [@anorebel](https://github.com/anorebel) scope ([697750d](https://github.com/AnoRebel/licensing/commit/697750d1b79c57f95d88422e899213b32626f8ec))
* **docs:** add examples for TS and Go consumers ([a17e251](https://github.com/AnoRebel/licensing/commit/a17e251ac75373f136e8262f95c2ef00b381a6b0))
* document OID allowlist, CSRF defence-in-depth, a11y posture, rc suffix ([b213ff0](https://github.com/AnoRebel/licensing/commit/b213ff01ff96572327358a54048adba2044a8310))
* **go:** refresh TS-package refs in doc comments ([f2effb3](https://github.com/AnoRebel/licensing/commit/f2effb3a9f8bdbd426059808595c4702f99678e3))
* **readme:** add version badges for npm, JSR, and pkg.go.dev ([2de9634](https://github.com/AnoRebel/licensing/commit/2de96341f24ffd45cf49ffdcd762bb416fe91adb))
* **readme:** lead with package capabilities; footnote the clean-room origin ([be22012](https://github.com/AnoRebel/licensing/commit/be22012d12a680bdbb690ddf23850acd5aa3e282))


### Chore

* rename TS package @licensing/sdk → @anorebel/licensing ([530a81f](https://github.com/AnoRebel/licensing/commit/530a81f01f26b987a79629eb11946364862f9c98))

## [Unreleased]

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
