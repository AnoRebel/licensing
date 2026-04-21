# licensing/crypto

Signature backends for the licensing issuer. Each subpackage registers a
single algorithm into `licensing.Backend`; import only the ones you use.

## Subpackages

- **ed25519** — default. 32-byte keys, deterministic signatures. `Backend()`
  signs + verifies; `VerifyBackend()` is verify-only for clients that must
  not hold a private key.
- **rsa** — RSA-PSS with SHA-256 and salt length 32. Rejects keys < 2048 bits
  at verification. Use `Backend()` for issuer, `VerifyBackend()` for clients.
- **hmac** — HMAC-SHA-256. Rejects secrets < 32 bytes. Symmetric — same
  `Backend()` signs and verifies.

## Alg-confusion mitigation

The validator pre-registers `kid → alg` pairs at construction time. A token
header claiming `alg: "ed25519"` for a `kid` registered as `rsa` fails with
`AlgorithmMismatch` before any backend is invoked.

## Registering

```go
import (
    "github.com/AnoRebel/licensing"
    ed25519b "github.com/AnoRebel/licensing/crypto/ed25519"
    rsab    "github.com/AnoRebel/licensing/crypto/rsa"
)

cfg := licensing.Config{
    Backends: []licensing.Backend{ed25519b.Backend(), rsab.Backend()},
    // …
}
```
