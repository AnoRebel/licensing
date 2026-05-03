# Framework integrations

The licensing toolkit ships **six middleware adapters** — three per
port — that all wrap a single shared core. The core does the
fingerprint extraction, calls `Client.guard`, and translates the
result into a canonical `(status, body)` pair. Each adapter is a
thin shim that turns that pair into the framework's native response.

A license issued by either runtime validates under all six adapters;
the cross-port matrix tests in CI enforce **byte-identical** error
bodies and status codes for every scenario.

## What you get

Every adapter does the same five things:

1. Extract the device fingerprint from the inbound request via a
   caller-supplied `Fingerprint` extractor. Returning `''` or an
   error short-circuits with **400 MissingFingerprint**.
2. Call `Client.guard({ fingerprint })`. The client validates the
   stored token signature, fingerprint binding, expiry, status, and
   any audience / issuer pins.
3. On success, attach the resolved `LicenseHandle` to the
   framework-native request context (Express `req.license`, Hono
   `c.get('license')`, Fastify `req.license`, chi
   `LicenseFromContext(ctx)`, gin `MustLicense(c)`, echo
   `LicenseFrom(c)`).
4. On failure, emit the canonical JSON envelope:
   `{ "error": "<ClientErrorCode>", "message": "<human>" }` with the
   matching HTTP status (401 for token-level, 403 for policy-level,
   404 / 422 / 429 / 502 / 503 for the rest — see
   `STATUS_BY_CODE` in `typescript/src/middleware/core.ts` and
   `licensing/middleware/core.go`).
5. Skip the downstream handler entirely on failure. No partial
   writes, no half-set headers.

## TypeScript

All TS adapters install with subpath imports under
`@anorebel/licensing/middleware/<framework>`. The package is
listed as an optional peer-dep — your bundler only pulls in the
adapter you import.

### Express 5

```ts
import express from 'express';
import { Client } from '@anorebel/licensing';
import { licenseGuard } from '@anorebel/licensing/middleware/express';

const client = new Client({ /* … */ });

const app = express();
app.use(
  licenseGuard({
    client,
    fingerprint: (req) => req.header('x-fingerprint') ?? '',
  }),
);

app.get('/protected', (req, res) => {
  res.json({ license: req.license.licenseKey });
});
```

### Hono 4

```ts
import { Hono } from 'hono';
import { Client } from '@anorebel/licensing';
import { licenseGuard } from '@anorebel/licensing/middleware/hono';

const client = new Client({ /* … */ });

const app = new Hono();
app.use(
  '*',
  licenseGuard({
    client,
    fingerprint: (c) => c.req.header('x-fingerprint') ?? '',
  }),
);

app.get('/protected', (c) => c.json({ license: c.get('license') }));
```

### Fastify 5

Fastify needs **one extra step** beyond the other two adapters: its
async preHandlers can't short-circuit with a `reply.send()` (the
`reply.sent` flag reads `raw.writableEnded`, which doesn't flip
synchronously). The adapter uses a `LicenseGuardError` thrown from
the preHandler, and the framework's error pipeline turns the throw
into the canonical JSON.

If you mount the guard via the **plugin** form, the error handler
is installed automatically:

```ts
import Fastify from 'fastify';
import { Client } from '@anorebel/licensing';
import { fastifyLicenseGuard } from '@anorebel/licensing/middleware/fastify';

const client = new Client({ /* … */ });
const app = Fastify();

await app.register(fastifyLicenseGuard, {
  client,
  fingerprint: (req) => req.headers['x-fingerprint'] as string | undefined ?? '',
});

app.get('/protected', async (req) => ({ license: req.license.licenseKey }));
```

If you'd rather use the **route-scoped** preHandler, install the
error handler once at startup:

```ts
import {
  licenseGuard,
  installLicenseErrorHandler,
} from '@anorebel/licensing/middleware/fastify';

installLicenseErrorHandler(app);

app.get('/protected', {
  preHandler: licenseGuard({ client, fingerprint }),
}, async (req) => ({ license: req.license.licenseKey }));
```

Skipping `installLicenseErrorHandler` produces a Fastify-default
`{statusCode, error, message}` shape that diverges from the other
adapters. The matrix test will catch the regression in CI.

## Go

All Go adapters live under `github.com/AnoRebel/licensing/licensing/middleware/<framework>`.

### chi v5

```go
import (
    "github.com/go-chi/chi/v5"
    "github.com/AnoRebel/licensing/licensing/easy"
    licensechi "github.com/AnoRebel/licensing/licensing/middleware/chi"
)

c, _ := easy.NewClient(easy.ClientConfig{ /* … */ })

r := chi.NewRouter()
r.Use(licensechi.LicenseMiddleware(licensechi.Config{
    Client: c,
    Fingerprint: func(req *http.Request) (string, error) {
        return req.Header.Get("X-Fingerprint"), nil
    },
}))

r.Get("/protected", func(w http.ResponseWriter, r *http.Request) {
    handle, _ := licensechi.LicenseFromContext(r.Context())
    json.NewEncoder(w).Encode(map[string]string{"license": handle.LicenseKey()})
})
```

### gin

```go
import (
    "github.com/gin-gonic/gin"
    "github.com/AnoRebel/licensing/licensing/easy"
    licensegin "github.com/AnoRebel/licensing/licensing/middleware/gin"
)

c, _ := easy.NewClient(easy.ClientConfig{ /* … */ })

r := gin.New()
r.Use(licensegin.LicenseMiddleware(licensegin.Config{
    Client: c,
    Fingerprint: func(gc *gin.Context) (string, error) {
        return gc.GetHeader("X-Fingerprint"), nil
    },
}))

r.GET("/protected", func(gc *gin.Context) {
    handle := licensegin.MustLicense(gc)
    gc.JSON(http.StatusOK, gin.H{"license": handle.LicenseKey()})
})
```

`MustLicense(c)` panics if the middleware didn't run for the
current request — that's a routing bug, not a runtime condition.
For optional access prefer `LicenseFrom(c) (handle, ok)`.

### echo v5

```go
import (
    echov5 "github.com/labstack/echo/v5"
    "github.com/AnoRebel/licensing/licensing/easy"
    licenseecho "github.com/AnoRebel/licensing/licensing/middleware/echo"
)

c, _ := easy.NewClient(easy.ClientConfig{ /* … */ })

e := echov5.New()
e.Use(licenseecho.LicenseMiddleware(licenseecho.Config{
    Client: c,
    Fingerprint: func(ec *echov5.Context) (string, error) {
        return ec.Request().Header.Get("X-Fingerprint"), nil
    },
}))

e.GET("/protected", func(ec *echov5.Context) error {
    handle, _ := licenseecho.LicenseFrom(ec)
    return ec.JSON(http.StatusOK, map[string]string{"license": handle.LicenseKey()})
})
```

The echo adapter targets **v5** specifically. v4 has a different
`Context` shape (interface vs struct in v5) and would need its own
adapter; we ship one for the version we recommend.

## On success: the LicenseHandle

The handle exposes the resolved license metadata for downstream
handlers — no need to call `Client.guard` again or look anything
up. The shape is the same in both ports:

| Property             | TS                                | Go                                  |
| -------------------- | --------------------------------- | ----------------------------------- |
| License key          | `handle.licenseKey`               | `handle.LicenseKey()`               |
| Active usages        | `handle.activeUsages`             | `handle.ActiveUsages()`             |
| Expires at (ISO)     | `handle.expiresAt`                | `handle.ExpiresAt()`                |
| Token claims         | `handle.claims` (full payload)    | `handle.Claims()`                   |

Reach for the claims when you need entitlement checks; reach for
the metadata fields when you just need a quick "license id" /
"expires" surface.

## On failure: the wire shape

A failing guard never reaches your handler. The middleware writes
this JSON, with the matching status code, and stops:

```json
{
  "error": "FingerprintMismatch",
  "message": "token fingerprint does not match this device"
}
```

The full mapping:

| Status | Codes                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------ |
| 400    | `MissingFingerprint`, `InvalidTokenFormat`                                                             |
| 401    | `NoToken`, `TokenExpired`, `TokenNotYetValid`, `TokenReplayed`                                         |
| 403    | `FingerprintMismatch`, `AudienceMismatch`, `IssuerMismatch`, `LicenseRevoked`, `LicenseSuspended`, `GraceExpired`, `RequiresOnlineRefresh` |
| 404    | `InvalidLicenseKey`, `UnknownKid`                                                                      |
| 422    | `UnsupportedAlgorithm`, `AlgorithmMismatch`                                                            |
| 429    | `RateLimited`                                                                                          |
| 502    | `IssuerProtocolError`                                                                                  |
| 503    | `IssuerUnreachable`                                                                                    |
| 500    | (any non-`ClientError` thrown — bug)                                                                   |

The codes are stable strings; downstream tooling (log aggregators,
SDK retry logic) keys off them and not the message. Adding a new
code requires a contract test update in both ports.

## See also

- `typescript/src/middleware/core.ts` / `licensing/middleware/core.go` —
  the shared status-code map.
- `typescript/tests/middleware/matrix.test.ts` /
  `licensing/middleware/matrix_test.go` — the parity tests that
  enforce byte-identical responses across all six adapters.
- [`README.md`](../README.md) — the high-level Issuer / Client
  quickstart.
