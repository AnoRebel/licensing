// Package client provides offline license verification for applications that
// embed licensing tokens.
//
// It is the Go counterpart of @licensing/client in the TypeScript workspace:
// given a trusted key bundle and a LIC1 token, it verifies the signature,
// enforces the not-before / expiry / grace window, and surfaces the typed
// payload. The client never talks to the issuer at verify time — all trust is
// anchored in the key bundle shipped with the application.
package client
