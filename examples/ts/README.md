# TypeScript examples

End-to-end runnable snippets for `@licensing/sdk` (issuer) and
`@licensing/sdk/client` (offline-first consumer).

> Go examples live under [`examples/go/`](../go/) — they run against the
> Go module at the repo root (`github.com/AnoRebel/licensing`).

## Prerequisites

```bash
cd /path/to/licensing
bun install
bun run build    # builds @licensing/sdk + @licensing/sdk/client dist/
```

## Files

- [`issue-and-verify.ts`](./issue-and-verify.ts) — full issuer flow against
  in-memory storage: bootstrap scope → generate root + signing key → create
  license → register usage → issue LIC1 token → independent verify with
  public key only.
- [`client-flow.ts`](./client-flow.ts) — client lifecycle against a mocked
  transport: activate → validate (offline) → heartbeat → refresh →
  deactivate.

## Run

```bash
bun run examples/ts/issue-and-verify.ts
bun run examples/ts/client-flow.ts
```

Both are self-contained — no env vars, no HTTP server required.
