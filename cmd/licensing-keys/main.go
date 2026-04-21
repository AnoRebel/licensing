package main

// `licensing-keys` CLI entrypoint — root/signing key management for
// @anorebel/licensing and github.com/AnoRebel/licensing.
//
// Mirrors typescript/packages/core/src/cli/main.ts. Subcommands:
//
//	make-root       Create a new root key.
//	issue-signing   Issue a signing key certified by a root.
//	rotate          Rotate the active signing key for (scope, alg).
//	list            List stored keys (no secrets).
//	help            Print usage.
//
// Passphrase input is ENV-ONLY. Never accepted on argv. Empty passphrases
// are refused: an unset or empty passphrase env var exits with code 1.
//
//	LICENSING_ROOT_PASSPHRASE      — unlocks / creates root keys
//	LICENSING_SIGNING_PASSPHRASE   — unlocks / creates signing keys
//
// Exit codes:
//
//	0   success
//	1   user error (bad args, empty passphrase, unknown alg, etc.)
//	2   system error (I/O, unexpected)

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	lic "github.com/AnoRebel/licensing/licensing"
	ed "github.com/AnoRebel/licensing/licensing/crypto/ed25519"
	hmacbe "github.com/AnoRebel/licensing/licensing/crypto/hmac"
	rsabe "github.com/AnoRebel/licensing/licensing/crypto/rsa"
)

const usage = `licensing-keys — root/signing key management for github.com/AnoRebel/licensing

USAGE
  licensing-keys <command> [options]

COMMANDS
  make-root      Create a root key
  issue-signing  Issue a signing key under a root
  rotate         Rotate the active signing key (outgoing -> retiring)
  list           List keys (no secrets)
  help           Print this usage

COMMON OPTIONS
  --store <path>      Path to the JSON keystore file (default: ./licensing-keys.json)
  --alg <alg>         Algorithm: ed25519 | rs256-pss
  --scope <id>        Scope id (optional; omit for global scope)
  --kid <string>      Override generated kid (optional)

make-root OPTIONS
  --not-after <iso>   Root validity end (optional)
  ENV: LICENSING_ROOT_PASSPHRASE (required, non-empty)

issue-signing OPTIONS
  --root-kid <kid>    Root kid to certify under (required)
  --not-after <iso>   Signing key validity end (optional)
  ENV: LICENSING_ROOT_PASSPHRASE, LICENSING_SIGNING_PASSPHRASE (both required, non-empty)

rotate OPTIONS
  --root-kid <kid>    Root kid (required; same scope+alg as the outgoing key)
  --retire-at <iso>   Clamp outgoing not_after to this instant (optional)
  ENV: LICENSING_ROOT_PASSPHRASE, LICENSING_SIGNING_PASSPHRASE (both required, non-empty)

list OPTIONS
  --role <role>       Filter: root | signing
  --state <state>     Filter: active | retiring

EXAMPLES
  LICENSING_ROOT_PASSPHRASE=... licensing-keys make-root --alg ed25519
  LICENSING_ROOT_PASSPHRASE=... LICENSING_SIGNING_PASSPHRASE=... \
    licensing-keys issue-signing --alg ed25519 --root-kid root-xyz

Note: hs256 (HMAC) is not supported by this CLI. HMAC is symmetric and has
no attestation chain to manage; provision HMAC secrets directly via the
licensing.KeyStore of your choice.
`

func main() {
	code := run(runOptions{
		argv:   os.Args[1:],
		getEnv: os.Getenv,
		stdout: os.Stdout,
		stderr: os.Stderr,
	})
	os.Exit(code)
}

type runOptions struct {
	stdout io.Writer
	stderr io.Writer
	getEnv func(string) string
	argv   []string
}

func run(opts runOptions) int {
	if len(opts.argv) == 0 {
		fmt.Fprint(opts.stdout, usage)
		return 0
	}
	cmd := opts.argv[0]
	rest := opts.argv[1:]
	switch cmd {
	case "-h", "--help", "help":
		fmt.Fprint(opts.stdout, usage)
		return 0
	case "make-root":
		return report(cmdMakeRoot(rest, opts), opts)
	case "issue-signing":
		return report(cmdIssueSigning(rest, opts), opts)
	case "rotate":
		return report(cmdRotate(rest, opts), opts)
	case "list":
		return report(cmdList(rest, opts), opts)
	default:
		fmt.Fprintf(opts.stderr, "licensing-keys: unknown command: %s\n\n%s", cmd, usage)
		return 1
	}
}

// report translates a command error into an exit code and user-facing
// message. LicensingError and usageError are exit=1 (user); anything else
// is exit=2 (system/bug).
func report(err error, opts runOptions) int {
	if err == nil {
		return 0
	}
	var ue *usageError
	if errors.As(err, &ue) {
		fmt.Fprintf(opts.stderr, "licensing-keys: %s\n", ue.Error())
		return 1
	}
	var le *lic.Error
	if errors.As(err, &le) {
		fmt.Fprintf(opts.stderr, "licensing-keys: %s: %s\n", le.Code, le.Message)
		return 1
	}
	fmt.Fprintf(opts.stderr, "licensing-keys: unexpected error: %s\n", err.Error())
	return 2
}

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func newUsage(format string, a ...any) *usageError {
	return &usageError{msg: fmt.Sprintf(format, a...)}
}

// -----------------------------------------------------------------------
// Subcommands
// -----------------------------------------------------------------------

type commonFlags struct {
	store    string
	alg      string
	scope    string
	kid      string
	scopeSet bool
}

func attachCommonFlags(fs *flag.FlagSet, c *commonFlags) {
	fs.StringVar(&c.store, "store", "./licensing-keys.json", "path to JSON keystore file")
	fs.StringVar(&c.alg, "alg", "", "algorithm: ed25519 | rs256-pss")
	fs.Func("scope", "scope id (optional; omit for global scope)", func(v string) error {
		c.scope = v
		c.scopeSet = true
		return nil
	})
	fs.StringVar(&c.kid, "kid", "", "override generated kid (optional)")
}

func cmdMakeRoot(argv []string, opts runOptions) error {
	fs := flag.NewFlagSet("make-root", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // silence default on parse error
	var c commonFlags
	attachCommonFlags(fs, &c)
	var notAfter string
	var notAfterSet bool
	fs.Func("not-after", "root validity end (optional)", func(v string) error {
		notAfter = v
		notAfterSet = true
		return nil
	})
	if err := fs.Parse(argv); err != nil {
		return newUsage("make-root: %s", err.Error())
	}
	alg, err := requireAlg(c.alg)
	if err != nil {
		return err
	}
	passphrase, err := requireEnv(opts.getEnv, "LICENSING_ROOT_PASSPHRASE")
	if err != nil {
		return err
	}
	kh, err := openHierarchy(c.store)
	if err != nil {
		return err
	}
	genOpts := lic.GenerateRootOptions{
		Alg:        alg,
		Passphrase: passphrase,
		Kid:        c.kid,
	}
	if c.scopeSet {
		genOpts.ScopeID = strPtr(c.scope)
	}
	if notAfterSet {
		genOpts.NotAfter = strPtr(notAfter)
	}
	rec, err := kh.GenerateRoot(genOpts)
	if err != nil {
		return err
	}
	fmt.Fprintln(opts.stdout, formatKey(*rec))
	return nil
}

func cmdIssueSigning(argv []string, opts runOptions) error {
	fs := flag.NewFlagSet("issue-signing", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c commonFlags
	attachCommonFlags(fs, &c)
	var rootKid, notAfter string
	var notAfterSet bool
	fs.StringVar(&rootKid, "root-kid", "", "root kid to certify under (required)")
	fs.Func("not-after", "signing key validity end (optional)", func(v string) error {
		notAfter = v
		notAfterSet = true
		return nil
	})
	if err := fs.Parse(argv); err != nil {
		return newUsage("issue-signing: %s", err.Error())
	}
	alg, err := requireAlg(c.alg)
	if err != nil {
		return err
	}
	if rootKid == "" {
		return newUsage("issue-signing: --root-kid is required")
	}
	rootPw, err := requireEnv(opts.getEnv, "LICENSING_ROOT_PASSPHRASE")
	if err != nil {
		return err
	}
	signingPw, err := requireEnv(opts.getEnv, "LICENSING_SIGNING_PASSPHRASE")
	if err != nil {
		return err
	}
	kh, err := openHierarchy(c.store)
	if err != nil {
		return err
	}
	issueOpts := lic.IssueSigningOptions{
		Alg:               alg,
		RootKid:           rootKid,
		RootPassphrase:    rootPw,
		SigningPassphrase: signingPw,
		Kid:               c.kid,
	}
	if c.scopeSet {
		issueOpts.ScopeID = strPtr(c.scope)
	}
	if notAfterSet {
		issueOpts.NotAfter = strPtr(notAfter)
	}
	rec, err := kh.IssueSigning(issueOpts)
	if err != nil {
		return err
	}
	fmt.Fprintln(opts.stdout, formatKey(*rec))
	return nil
}

func cmdRotate(argv []string, opts runOptions) error {
	fs := flag.NewFlagSet("rotate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c commonFlags
	attachCommonFlags(fs, &c)
	var rootKid, retireAt string
	var retireSet bool
	fs.StringVar(&rootKid, "root-kid", "", "root kid (required)")
	fs.Func("retire-at", "clamp outgoing not_after (optional)", func(v string) error {
		retireAt = v
		retireSet = true
		return nil
	})
	if err := fs.Parse(argv); err != nil {
		return newUsage("rotate: %s", err.Error())
	}
	alg, err := requireAlg(c.alg)
	if err != nil {
		return err
	}
	if rootKid == "" {
		return newUsage("rotate: --root-kid is required")
	}
	rootPw, err := requireEnv(opts.getEnv, "LICENSING_ROOT_PASSPHRASE")
	if err != nil {
		return err
	}
	signingPw, err := requireEnv(opts.getEnv, "LICENSING_SIGNING_PASSPHRASE")
	if err != nil {
		return err
	}
	kh, err := openHierarchy(c.store)
	if err != nil {
		return err
	}
	rotOpts := lic.RotateSigningOptions{
		Alg:               alg,
		RootKid:           rootKid,
		RootPassphrase:    rootPw,
		SigningPassphrase: signingPw,
		Kid:               c.kid,
	}
	if c.scopeSet {
		rotOpts.ScopeID = strPtr(c.scope)
	}
	if retireSet {
		rotOpts.RetireOutgoingAt = strPtr(retireAt)
		rotOpts.RetireOutgoingSet = true
	}
	res, err := kh.RotateSigning(rotOpts)
	if err != nil {
		return err
	}
	fmt.Fprintln(opts.stdout, "retiring:")
	fmt.Fprintln(opts.stdout, formatKey(res.Outgoing))
	fmt.Fprintln(opts.stdout)
	fmt.Fprintln(opts.stdout, "active:")
	fmt.Fprintln(opts.stdout, formatKey(res.Incoming))
	return nil
}

func cmdList(argv []string, opts runOptions) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var storePath, roleStr, stateStr, algStr, scopeStr string
	var scopeSet bool
	fs.StringVar(&storePath, "store", "./licensing-keys.json", "keystore path")
	fs.StringVar(&roleStr, "role", "", "filter: root | signing")
	fs.StringVar(&stateStr, "state", "", "filter: active | retiring")
	fs.StringVar(&algStr, "alg", "", "filter: ed25519 | rs256-pss | hs256")
	fs.Func("scope", "filter on scope id", func(v string) error {
		scopeStr = v
		scopeSet = true
		return nil
	})
	if err := fs.Parse(argv); err != nil {
		return newUsage("list: %s", err.Error())
	}
	store, err := NewJSONFileKeyStore(storePath)
	if err != nil {
		return err
	}
	filter := lic.KeyStoreFilter{}
	if scopeSet {
		filter.ScopeIDSet = true
		filter.ScopeID = strPtr(scopeStr)
	}
	if roleStr != "" {
		r := lic.KeyRole(roleStr)
		if r != lic.RoleRoot && r != lic.RoleSigning {
			return newUsage("list: --role must be root | signing")
		}
		filter.Role = &r
	}
	if stateStr != "" {
		st := lic.KeyState(stateStr)
		if st != lic.StateActive && st != lic.StateRetiring {
			return newUsage("list: --state must be active | retiring")
		}
		filter.State = &st
	}
	if algStr != "" {
		a := lic.KeyAlg(algStr)
		filter.Alg = &a
	}
	recs, err := store.List(filter)
	if err != nil {
		return err
	}
	if len(recs) == 0 {
		fmt.Fprintln(opts.stdout, "(no keys)")
		return nil
	}
	for _, rec := range recs {
		fmt.Fprintln(opts.stdout, formatKey(rec))
	}
	return nil
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

var validAlgs = []lic.KeyAlg{lic.AlgEd25519, lic.AlgRSAPSS}

func requireAlg(v string) (lic.KeyAlg, error) {
	if v == "" {
		return "", newUsage("--alg is required")
	}
	alg := lic.KeyAlg(v)
	if slices.Contains(validAlgs, alg) {
		return alg, nil
	}
	names := make([]string, 0, len(validAlgs))
	for _, a := range validAlgs {
		names = append(names, string(a))
	}
	return "", newUsage("--alg must be one of: %s (got %s)", strings.Join(names, ", "), v)
}

func requireEnv(getEnv func(string) string, name string) (string, error) {
	v := getEnv(name)
	if v == "" {
		return "", newUsage("env var %s is required and must be non-empty", name)
	}
	return v, nil
}

func openHierarchy(storePath string) (*lic.KeyHierarchy, error) {
	store, err := NewJSONFileKeyStore(storePath)
	if err != nil {
		return nil, err
	}
	reg := lic.NewAlgorithmRegistry()
	// All supported backends compiled in. HMAC is intentionally omitted
	// since ensureAsymmetricAlg rejects it at every hierarchy entry point;
	// leaving it registered would only let `list --alg hs256` succeed on
	// foreign records, which is actually fine — so we still register it
	// for that read-only case but never expose it in requireAlg.
	_ = reg.Register(ed.New())
	_ = reg.Register(rsabe.New())
	_ = reg.Register(hmacbe.New())
	return lic.NewKeyHierarchy(lic.KeyHierarchyOptions{
		Store:    store,
		Registry: reg,
	})
}

func formatKey(rec lic.LicenseKey) string {
	// Never print private material. Show the public surface + state only.
	scope := "(global)"
	if rec.ScopeID != nil {
		scope = *rec.ScopeID
	}
	notAfter := "(none)"
	if rec.NotAfter != nil {
		notAfter = *rec.NotAfter
	}
	lines := []string{
		fmt.Sprintf("  id:         %s", rec.ID),
		fmt.Sprintf("  kid:        %s", rec.Kid),
		fmt.Sprintf("  alg:        %s", rec.Alg),
		fmt.Sprintf("  role:       %s", rec.Role),
		fmt.Sprintf("  state:      %s", rec.State),
		fmt.Sprintf("  scope:      %s", scope),
		fmt.Sprintf("  not_before: %s", rec.NotBefore),
		fmt.Sprintf("  not_after:  %s", notAfter),
	}
	if rec.RotatedFrom != nil {
		lines = append(lines, fmt.Sprintf("  rotated_from: %s", *rec.RotatedFrom))
	}
	return strings.Join(lines, "\n")
}

func strPtr(s string) *string { return &s }
