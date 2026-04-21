# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three artefacts are released in lockstep — `@anorebel/licensing` on npm,
`@anorebel/licensing` on jsr.io, and `github.com/AnoRebel/licensing` on
pkg.go.dev. A single entry below describes all three.

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
