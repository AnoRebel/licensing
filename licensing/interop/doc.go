// Package interop exercises cross-language parity between the Go and
// TypeScript licensing implementations.
//
// The tests in this package drive three round-trip harnesses:
//
//  1. Token round-trip (phase 12.1) — for every (alg, fixture) pair, sign a
//     token with TypeScript, verify it with Go; then sign with Go, verify
//     with TypeScript. Any divergence (envelope, canonical JSON, signature
//     format) surfaces as a concrete verify failure.
//
//  2. Canonical-JSON diff (phase 12.2) — randomized (yet deterministic,
//     seeded) payloads are canonicalized by both implementations. The
//     resulting bytes must be byte-identical for 10,000 iterations.
//
//  3. Grace-period transition table (phase 12.3) — a fixed table of
//     (status, now, exp, force_online_after, fingerprint) tuples feeds both
//     client validators. The emitted classification code must agree.
//
// # Skipping
//
// The TS half of each harness shells out to Bun via the `interop-sign`,
// `interop-verify`, `interop-canonicalize`, and `interop-classify` CLIs at
// tools/interop/bin/. If Bun is not on PATH, the tests skip with a
// diagnostic rather than fail — so developers without the JS toolchain can
// still run `go test ./...`. CI is expected to have Bun installed and the
// `@licensing/interop` workspace resolved via `bun install`.
package interop
