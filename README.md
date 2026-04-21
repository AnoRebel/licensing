# licensing

A clean-room reimplementation of
[masterix21/laravel-licensing](https://github.com/masterix21/laravel-licensing),
[laravel-licensing-client](https://github.com/masterix21/laravel-licensing-client),
and the Filament manager — built as standalone TypeScript and Go libraries with
a shared token format, shared test fixtures, and a Nuxt-based admin UI.

> **Status:** pre-release. Tracking `v0.1.0`. Not yet production-ready.

## What's in the box

```
licensing/
├─ typescript/         # @licensing/sdk (single package, subpath exports)
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
- **Framework-agnostic HTTP.** `@licensing/sdk/http` ships optional
  Hono/Express/Fastify adapters; the Go `licensing/http` package ships
  `http.Handler` constructors that drop into echo/chi/gorilla/stdlib.
- **Shared OpenAPI contract.** `openapi/licensing-admin.yaml` is the single
  source of truth; both the TS and Go handlers run a contract-conformance
  suite against it in CI.

## Quickstart — TypeScript

```bash
bun install
bun run --filter '@licensing/sdk' build
bun run --filter '@licensing/sdk' test
```

Minimal issuer flow (once packages land in phase 3–5):

```ts
import { createIssuer } from '@licensing/sdk';
import { ed25519 } from '@licensing/crypto-ed25519';
import { memoryStorage } from '@licensing/sdk/storage/memory';

const issuer = await createIssuer({
  storage: memoryStorage(),
  crypto: { ed25519 },
  activeKid: 'k1',
});

const license = await issuer.createLicense({ scopeId: 's1', seats: 3 });
const token = await issuer.issueToken(license, { ttlSeconds: 3600 });
```

## Quickstart — Go

```bash
cd golang
go test ./...
```

```go
import (
    "github.com/AnoRebel/licensing"
    "github.com/AnoRebel/licensing/crypto/ed25519"
    "github.com/AnoRebel/licensing/storage/memory"
)

issuer, _ := licensing.NewIssuer(licensing.Config{
    Storage:   memory.New(),
    Backends:  []licensing.Backend{ed25519.Backend()},
    ActiveKID: "k1",
})

lic, _ := issuer.CreateLicense(ctx, licensing.NewLicense{ScopeID: "s1", Seats: 3})
tok, _ := issuer.IssueToken(ctx, lic, licensing.TokenOpts{TTL: time.Hour})
```

## Admin UI

```bash
bun install
bun run --filter '@licensing/admin' dev
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
  Bumps go through a dedicated change proposal under `openspec/changes/`.

## License & attribution

This project is a **clean-room** reimplementation. It takes design inspiration
from the Laravel packages cited above but shares no code with them. See
`NOTICE` for details.
