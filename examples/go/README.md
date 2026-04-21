# Go examples

End-to-end runnable snippets for the Go issuer and client.

## Prerequisites

```bash
cd /path/to/licensing/golang
go mod download
```

Go 1.26+.

## Files

- [`issue_and_verify.go`](./issue_and_verify.go) — full issuer flow against
  in-memory storage: bootstrap scope → generate root + signing key → create
  license → register usage → issue LIC1 token → independent verify with
  public key only.
- [`client_flow.go`](./client_flow.go) — client lifecycle with a mocked
  `http.RoundTripper`: activate → validate (offline) → heartbeat → refresh
  → deactivate.

## Run

```bash
cd golang
go run ./examples/issue_and_verify.go
go run ./examples/client_flow.go
```

Both are self-contained — no env vars, no HTTP server required.
