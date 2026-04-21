# licensing

Framework-agnostic Go primitives for the licensing issuer: canonical JSON,
the LIC1 codec, key hierarchy, lifecycle state machine, signature backends,
and storage + HTTP surfaces.

Pairs byte-for-byte with the TypeScript port in `typescript/packages/*` — a
token signed by one verifies in the other, enforced in CI by
`licensing/interop/`.

## Install

```bash
go get github.com/AnoRebel/licensing
```

Go 1.26+. The module uses generics in the storage interface and the Go 1.22+
range-over-int loop idiom in tests.

## Usage

The issuer API is a set of free functions that take a `Storage` and `Clock`
explicitly — no global state, easy to test. See
[`examples/issue_and_verify.go`](../examples/issue_and_verify.go)
for a full runnable example.

```go
import (
    licensing "github.com/AnoRebel/licensing"
    "github.com/AnoRebel/licensing/crypto/ed25519"
    "github.com/AnoRebel/licensing/storage/memory"
)

registry := licensing.NewAlgorithmRegistry()
_ = registry.Register(ed25519.New())

store := memory.New()
clk   := licensing.SystemClock{}

root, _    := licensing.GenerateRootKey(store, clk, registry, licensing.GenerateRootKeyInput{
    Alg: licensing.AlgEd25519, Passphrase: "root-pw",
}, licensing.KeyIssueOptions{})

signing, _ := licensing.IssueInitialSigningKey(store, clk, registry, licensing.IssueInitialSigningKeyInput{
    Alg: licensing.AlgEd25519, RootKid: root.Kid,
    RootPassphrase: "root-pw", SigningPassphrase: "sign-pw",
}, licensing.KeyIssueOptions{})

lic, _ := licensing.CreateLicense(store, clk, licensing.CreateLicenseInput{
    LicensableType: "User", LicensableID: "u1", MaxUsages: 3,
}, licensing.CreateLicenseOptions{})

tok, _ := licensing.IssueToken(store, clk, registry, licensing.IssueTokenInput{
    License: lic, TTLSeconds: 3600,
    Alg: licensing.AlgEd25519, SigningPassphrase: "sign-pw",
})
// tok.Token == "LIC1.<header>.<payload>.<sig>"
_ = signing
```

## Subpackages

| Package                             | Purpose                                            |
|------------------------------------|----------------------------------------------------|
| `licensing/client`                  | Offline-first client: validate, activate, refresh. |
| `licensing/crypto/{ed25519,rsa,hmac}` | Signature backends.                              |
| `licensing/storage/{memory,postgres,sqlite}` | Storage adapters.                         |
| `licensing/storage/conformance`     | Shared schema/behaviour tests all adapters pass.   |
| `licensing/http`                    | `net/http`-compatible reference handlers.          |
| `licensing/interop`                 | TS↔Go cross-language harness (CI-only, build-tag `interop`). |

## Token format

See `docs/token-format.md` for LIC1 canonicalization and validation rules.
Go and TS canonical-JSON outputs are byte-identical by construction.
