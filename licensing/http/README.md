# licensing/http

`net/http`-compatible reference handlers for the licensing issuer. Registers
against any stdlib-shaped mux (`http.ServeMux`, `chi.Router`, `echo.Echo`,
`gorilla/mux`, …). Contract-conformant with `openapi/licensing-admin.yaml` —
the same contract the TS `@licensing/sdk/http` package verifies.

## Usage

```go
import (
    "net/http"

    licensinghttp "github.com/AnoRebel/licensing/http"
)

mux := http.NewServeMux()
h := licensinghttp.New(licensinghttp.Config{Issuer: issuer})
h.Mount(mux)

_ = http.ListenAndServe(":8080", mux)
```

Mounts the admin surface (`/admin/licenses`, `/admin/scopes`, `/admin/usages`,
`/admin/audit`, `/admin/keys`) and the client endpoints (`/v1/auth/me`,
`/v1/activate`, `/v1/refresh`, `/v1/heartbeat`, `/v1/deactivate`).

## Auth

`Config.Authenticate` is a `func(*http.Request) (Principal, error)` — plug in
whatever your stack uses (bearer tokens, mTLS, SSO). Returning an error
short-circuits to `401 AuthenticationRequired`.

## Contract tests

```bash
go test ./licensing/http/... -tags=contract -run TestContract
```

Replays every example pair in `openapi/licensing-admin.yaml`. Both the Go and
TS handlers run this suite in CI (`openapi-contract.yml`) — drift in either
implementation fails the build.
