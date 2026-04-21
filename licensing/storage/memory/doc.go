// Package memory provides an in-process Storage implementation backed by Go
// maps and slices.
//
// Mirrors @anorebel/licensing/storage/memory. Intended for tests, local development,
// and ephemeral use cases. All state is lost when the process exits. Not
// safe for production.
package memory
