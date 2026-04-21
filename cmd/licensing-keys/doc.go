// Command licensing-keys is the admin CLI for managing the licensing key
// hierarchy.
//
// Mirrors the `licensing keys:*` artisan commands in the PHP reference and
// the @licensing/core keys helpers. Subcommands:
//
//	make-root      Generate a new root key (ed25519 by default)
//	issue-signing  Mint a signing key wrapped by an existing root key
//	rotate         Rotate the active signing key
//
// Passphrases are read from the LICENSING_ROOT_PASSPHRASE and
// LICENSING_SIGNING_PASSPHRASE environment variables — never from argv.
package main
