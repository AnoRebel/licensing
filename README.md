# licensing

[![npm version](https://img.shields.io/npm/v/@anorebel/licensing?label=npm&logo=npm&color=cb3837)](https://www.npmjs.com/package/@anorebel/licensing)
[![JSR version](https://jsr.io/badges/@anorebel/licensing)](https://jsr.io/@anorebel/licensing)
[![Go module version](https://img.shields.io/github/v/tag/AnoRebel/licensing?label=pkg.go.dev&logo=go&color=00add8&sort=semver)](https://pkg.go.dev/github.com/AnoRebel/licensing)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

An offline-capable software licensing toolkit. Issue signed license tokens,
activate them against a device fingerprint, and verify them without a network
round-trip — from either TypeScript or Go, with a shared token format and a
Nuxt-based admin console for the control plane.[^origin]

The two ports are byte-compatible: a license issued by the Go module verifies
under `@anorebel/licensing` and vice versa, enforced by cross-language interop tests
in CI. Both expose the same building blocks — key hierarchy, issuer lifecycle,
HTTP handlers, pluggable storage (memory, Postgres, SQLite) — so you can pick
the runtime that fits your stack without rewriting the licensing layer.

> **Status:** pre-release. Tracking `v0.1.0`. Not yet production-ready.

## What's in the box

```
licensing/
├─ typescript/         # @anorebel/licensing (single package, subpath exports)
│  └─ src/                       # /crypto/{ed25519,rsa,hmac}, /client, /http,
│                                # /storage/{memory,postgres,sqlite}, /cli
├─ licensing/                    # Go module github.com/AnoRebel/licensing
│  ├─ client/                    # offline + online client
│  ├─ crypto/{ed25519,rsa,hmac}/
│  ├─ storage/{memory,postgres,sqlite}/
│  └─ http/                      # net/http-compatible handlers
├─ cmd/licensing-keys/           # Go CLI for key generation/inspection
├─ admin/                        # Nuxt 4 + shadcn-vue admin UI
├─ fixtures/                     # canonical test vectors shared by both ports
├─ openapi/                      # single source of truth for the HTTP surface
├─ examples/                     # runnable TS + Go examples
└─ tools/                        # fixture generator, interop harness, etc.
```

## Design at a glance

- **Own token format (LIC1).** Four-part base64url envelope over canonical
  JSON: `LIC1.<header_b64>.<payload_b64>.<sig_b64>`. Canonicalization rules
  are specified in `fixtures/README.md` and enforced by byte-identical
  fixture tests in both languages. A version prefix keeps the door open for
  a future `LIC2` = PASETO-compatible layer without breaking v1 consumers.
- **Pluggable crypto.** Ed25519 (default), RSA-PSS, HMAC-SHA-256 — all
  register into a shared backend registry keyed by the header `alg`.
  Algorithm-confusion attacks are blocked by pre-registered `kid → alg`
  bindings.
- **Pluggable storage.** Memory, Postgres (pgx/v5 + `pg`), and SQLite
  (`bun:sqlite` + `modernc.org/sqlite`) adapters, all satisfying the same
  schema-parity tests.
- **Framework-agnostic HTTP.** `@anorebel/licensing/http` ships optional
  Hono/Express/Fastify adapters; the Go `licensing/http` package ships
  `http.Handler` constructors that drop into echo/chi/gorilla/stdlib.
- **Shared OpenAPI contract.** `openapi/licensing-admin.yaml` is the single
  source of truth; both the TS and Go handlers run a contract-conformance
  suite against it in CI.

## Quickstart

The high-level API (`@anorebel/licensing` → `Issuer` / `Client`,
`licensing/easy` → `easy.Issuer` / `easy.Client`) wraps the primitives
and auto-generates a signing key on first use. Five lines per side is
enough to issue your first license. See the full example scripts at
[`examples/ts/`](examples/ts) and [`examples/go/`](examples/go).

### TypeScript

```bash
bun add @anorebel/licensing
```

```ts
import { Issuer } from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

const issuer = new Issuer({
  db: new MemoryStorage(),
  signing: { passphrase: process.env.LICENSING_SIGNING_PW! },
});

const license = await issuer.issue({
  licensableType: 'User',
  licensableId: 'user-42',
  maxUsages: 3,
});
```

### Go

```bash
go get github.com/AnoRebel/licensing
```

```go
import (
    "context"
    "github.com/AnoRebel/licensing/licensing/easy"
    "github.com/AnoRebel/licensing/licensing/storage/memory"
)

issuer, _ := easy.NewIssuer(easy.IssuerConfig{
    DB:      memory.New(memory.Options{}),
    Signing: &easy.SigningConfig{Passphrase: os.Getenv("LICENSING_SIGNING_PW")},
})

license, _ := issuer.Issue(context.Background(), easy.IssueInput{
    LicensableType: "User",
    LicensableID:   "user-42",
    MaxUsages:      5,
})
```

The `Issuer` writes a `license.created` audit row, picks an active
signing key (auto-generating one if storage is empty), and returns a
ready-to-distribute license. The corresponding `Client` (TS) /
`easy.Client` (Go) handles activation, refresh, and offline validation
on the device side; the framework adapters under
[`docs/framework-integrations.md`](docs/framework-integrations.md)
plug it into your HTTP layer with a single middleware call.

### Quickstart (primitives)

If you need fine-grained control — a custom signing-key flow, manual
audit-log calls, or a non-default storage — every step the `Issuer`
wraps is exposed as a top-level function. The full primitive flow
(scope → root key → signing key → license → usage → token → verify)
lives in:

- [`examples/ts/issue-and-verify.ts`](examples/ts/issue-and-verify.ts)
- [`examples/go/issue_and_verify.go`](examples/go/issue_and_verify.go)

…and the surface area is documented as a whole in
[`docs/security.md`](docs/security.md) and
[`docs/token-format.md`](docs/token-format.md).

## Admin UI

```bash
bun install
cd admin
bun run dev
```

The admin UI is a fully typed Nuxt 4 app consuming `openapi/licensing-admin.yaml`
via a generated client. Dark mode, keyboard-first flows, and axe-core
accessibility checks are part of CI.

## Security model

- Two-level key hierarchy (root + signing keys). Signing keys rotate; retiring
  keys continue to verify outstanding tokens until `exp`.
- Private keys are PKCS#8 PEM encrypted with PBES2 (PBKDF2-HMAC-SHA-256 +
  AES-256-GCM). Passphrases come from env; the CLI refuses empty passphrases.
- RSA ≥ 2048 bits enforced at verification. HMAC secrets ≥ 32 bytes.
- `kid → alg` is pre-registered at validator construction; any mismatch fails
  with `AlgorithmMismatch` before any backend is invoked.

See `docs/security.md` (landing in task 14.3) for full details.

## Contributing

- Commits are gated by [lefthook](https://lefthook.dev): Biome check, gofmt,
  golangci-lint (new-from-rev HEAD), and a PEM-marker secrets scan.
- Pull requests run the full matrix: `ts.yml`, `go.yml`, `admin-ui.yml`,
  `openapi-contract.yml`, `interop.yml`. All five are required for merge.
- Versions are pinned exactly in `package.json`, `go.mod`, and `VERSIONS.md`.
  Bumps are reviewed deliberately and edited alongside the dependency change.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

## Comparison with Laravel licensing

This toolkit is a clean-room reimplementation of
[`masterix21/laravel-licensing`](https://github.com/masterix21/laravel-licensing)
+ its companion client + Filament manager, retargeting TypeScript and
Go. The mental model carries over — but a few things were renamed,
and a few were added that don't have a Laravel-side counterpart.

| Laravel licensing             | This toolkit                          | Notes                                                                                                |
| ----------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `License`                     | `License`                             | Same: a row that owns lifecycle state and references one licensable.                                 |
| `LicenseScope`                | `LicenseScope` (just `Scope` in URLs) | Same: multi-tenant boundary keyed by `slug`.                                                         |
| `LicenseTemplate`             | `LicenseTemplate`                     | Same shape, plus `parent_id` for inheritance and `trial_cooldown_sec` for trials. See [`docs/templates.md`](docs/templates.md). |
| Polymorphic `licensable`      | `(licensable_type, licensable_id)`    | Same convention; the licensing service stays agnostic of who the consumer's `User` is.               |
| `LicenseUsage` / `Activation` | `LicenseUsage`                        | Same: per-fingerprint seat row with `active` / `revoked` status.                                     |
| `Heartbeat`                   | `Heartbeat`                           | Same: periodic check-in. Our token carries `force_online_after_sec` so the validator can refuse offline use past a hard stop. |
| Token signing config          | `KeyHierarchy` (root + signing)       | Two-tier hierarchy with rotation. Laravel signs with one key; we add an explicit root → signing key separation so signing keys can rotate without re-issuing the root. |
| `EnsureSubscriptionIsActive`  | `Client.guard()` + framework adapters | Same idea. Six adapters (Express / Hono / Fastify / chi / gin / echo) instead of one Laravel middleware. See [`docs/framework-integrations.md`](docs/framework-integrations.md). |
| Trial flag on the License     | `trial_issuances` row + `is_trial` claim | The flag persists; we additionally record a peppered `(template_id, fingerprint_hash)` row so the same device can't claim the same trial twice. See [`docs/trials.md`](docs/trials.md). |
| Filament panels               | Nuxt 4 + shadcn-vue admin             | The admin UI is structurally similar — Licenses / Scopes / Templates / Usages / Audit — but rebuilt as a typed Nuxt SPA against the OpenAPI contract. |
| Eloquent observers / events   | Append-only `AuditLog`                | Every state-changing operation writes an audit row inside the same transaction. The HTTP `POST` / `PATCH` / `DELETE` paths and the Go / TS service layers all share the same writer. |
| —                             | LIC1 token format                     | The on-wire token is ours, not a JWT. Spec lives in [`docs/token-format.md`](docs/token-format.md).  |
| —                             | OpenAPI single source of truth        | Both the TS and Go HTTP layers run a contract-conformance suite against `openapi/licensing-admin.yaml`. The admin UI's typed client is regenerated from the same file. |
| —                             | Cross-port byte parity                | A license issued by one runtime validates under the other; CI runs an interop matrix on every fixture. |

**Differences worth flagging when migrating from Laravel licensing:**

- The token format is **LIC1**, not JWT. JWT-shaped tokens are
  rejected with `UnsupportedTokenFormat`. See
  [`docs/token-format.md`](docs/token-format.md).
- The HTTP API has **no implicit Eloquent / Filament conventions**;
  every endpoint is documented in `openapi/licensing-admin.yaml`
  and shares a `{ "data": ... }` / `{ "error": { "code", "message" }, "success": false }` envelope.
- **`LicenseTemplate.parent_id`** is new — Laravel licensing has
  flat templates only. Inheritance is opt-in; flat templates work
  exactly like before.
- **Trials** are a first-class concept with per-fingerprint dedupe
  and a peppered hash. Laravel licensing tracks "is this a trial"
  on the License but doesn't enforce uniqueness across re-activation.
- **No Eloquent**, no Laravel container. The Issuer / Client are
  pure constructors that take a `Storage` adapter — pick `MemoryStorage`,
  `SqliteStorage`, or `PostgresStorage` per deployment.

---

[^origin]: Design inspired by
    [masterix21/laravel-licensing](https://github.com/masterix21/laravel-licensing),
    [laravel-licensing-client](https://github.com/masterix21/laravel-licensing-client),
    and the Filament manager. This is a clean-room reimplementation — no code is
    shared with those packages; see `NOTICE` for details.
