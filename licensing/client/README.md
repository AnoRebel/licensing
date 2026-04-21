# licensing/client

Offline-first Go client for LIC1 tokens: validation, activation lifecycle,
and grace-on-unreachable. Mirrors `@anorebel/licensing/client` one-for-one so a license
activated in one language validates in the other.

## Usage

```go
import (
    "github.com/AnoRebel/licensing/client"
    ed25519b "github.com/AnoRebel/licensing/crypto/ed25519"
)

c, err := client.New(client.Config{
    BaseURL:    "https://licensing.example.com",
    PublicKeys: map[string]client.PublicKey{"k1": {Alg: "ed25519", PEM: pubPEM}},
    Backends:   []client.Backend{ed25519b.VerifyBackend()},
    DeviceID:   "stable-fingerprint",
    Storage:    client.FileStorage("./license.cache"),
    Grace:      24 * time.Hour,
})

// Online.
session, err := c.Activate(ctx, client.ActivateRequest{LicenseKey: "LK-ABCD-..."})

// Offline — validates the cached token against `now` with grace on unreachable.
if res := c.Validate(time.Now()); !res.OK {
    return res.Err
}

_ = c.Heartbeat(ctx)
_ = c.Refresh(ctx)
```

### Grace semantics

Matches the TS client exactly: `exp < now` fails strict, `exp ≤ now + grace`
passes when the server is unreachable. Null `exp` means "no expiry" and
disables grace. See `interop/TestGracePeriodTable_TSvsGo` for the full table.

## Errors

`client.ErrTokenExpired`, `client.ErrSignatureMismatch`,
`client.ErrAlgorithmMismatch`, `client.ErrDeviceMismatch`,
`client.ErrSeatLimitReached`, `client.ErrUnreachable`. Match the error codes
in `licensing/errors.go` and the TS client's error constants.
