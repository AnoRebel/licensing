// Package licensing is the Go port of the licensing issuer core.
//
// It mirrors @anorebel/licensing from the TypeScript workspace and provides:
//
//   - Canonical JSON serialization (byte-identical with the TS canonicalizer)
//   - The LIC1 token envelope (encode / decode / strict field whitelists)
//   - A pluggable SignatureBackend interface (ed25519 / RSA-PSS / HMAC-SHA256)
//   - The encrypted-at-rest key hierarchy (root / signing / rotation)
//   - The sentinel-error taxonomy matched 1:1 with LicensingErrorCode in TS
//
// Licenses minted by github.com/AnoRebel/licensing are interoperable with
// @anorebel/licensing tokens: the same kid, alg, canonical payload, and signature
// verify in either runtime. The normative contract lives in fixtures/README.md
// at the repo root and is exercised by the cross-language interop test suite.
package licensing
