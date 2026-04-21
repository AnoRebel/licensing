# licensing

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

## Quickstart — TypeScript

```bash
bun install
cd typescript
bun run build
bun test
```

Minimal issuer flow (see `examples/ts/issue-and-verify.ts` for the full script):

```ts
import {
  createAdvancingClock,
  createLicense,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  issueToken,
  registerUsage,
  type KeyAlg,
  type SignatureBackend,
} from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';

const clock = createAdvancingClock('2026-04-19T10:00:00.000000Z');
const storage = new MemoryStorage({ clock });
const backends = new Map<KeyAlg, SignatureBackend>([['ed25519', ed25519Backend]]);

const root = await generateRootKey(storage, clock, backends, {
  scope_id: null,
  alg: 'ed25519',
  passphrase: 'root-pw',
});

const signing = await issueInitialSigningKey(storage, clock, backends, {
  scope_id: null,
  alg: 'ed25519',
  rootKid: root.kid,
  rootPassphrase: 'root-pw',
  signingPassphrase: 'sign-pw',
});

const license = await createLicense(storage, clock, {
  scope_id: null,
  template_id: null,
  licensable_type: 'User',
  licensable_id: 'user-42',
  max_usages: 3,
});

const { usage, license: active } = await registerUsage(storage, clock, {
  license_id: license.id,
  fingerprint: 'a'.repeat(64),
});

const { token } = await issueToken(storage, clock, backends, {
  license: active,
  usage,
  ttlSeconds: 3600,
  alg: 'ed25519',
  signingPassphrase: 'sign-pw',
});
```

## Quickstart — Go

```bash
go test ./...
```

```go
import (
    lic "github.com/AnoRebel/licensing/licensing"
    "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
    "github.com/AnoRebel/licensing/licensing/storage/memory"
)

clk := lic.SystemClock{}
store := memory.New(memory.Options{})
registry := lic.NewAlgorithmRegistry()
_ = registry.Register(ed25519.New())

root, _ := lic.GenerateRootKey(store, clk, registry, lic.GenerateRootKeyInput{
    Alg: lic.AlgEd25519, Passphrase: "root-pw",
}, lic.KeyIssueOptions{})

signing, _ := lic.IssueInitialSigningKey(store, clk, registry, lic.IssueInitialSigningKeyInput{
    Alg:               lic.AlgEd25519,
    RootKid:           root.Kid,
    RootPassphrase:    "root-pw",
    SigningPassphrase: "sign-pw",
}, lic.KeyIssueOptions{})

license, _ := lic.CreateLicense(store, clk, lic.CreateLicenseInput{
    LicensableType: "User", LicensableID: "user-42",
    Status: lic.LicenseStatusActive, MaxUsages: 3,
}, lic.CreateLicenseOptions{})

usage, _ := lic.RegisterUsage(store, clk, lic.RegisterUsageInput{
    LicenseID:   license.ID,
    Fingerprint: strings.Repeat("a", 64),
}, lic.RegisterUsageOptions{})

tok, _ := lic.IssueToken(store, clk, registry, lic.IssueTokenInput{
    License:           license,
    Usage:             usage.Usage,
    TTLSeconds:        3600,
    Alg:               lic.AlgEd25519,
    SigningPassphrase: "sign-pw",
})
_ = signing
_ = tok
```

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
  Bumps go through a dedicated change proposal under `openspec/changes/`.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

[^origin]: Design inspired by
    [masterix21/laravel-licensing](https://github.com/masterix21/laravel-licensing),
    [laravel-licensing-client](https://github.com/masterix21/laravel-licensing-client),
    and the Filament manager. This is a clean-room reimplementation — no code is
    shared with those packages; see `NOTICE` for details.
