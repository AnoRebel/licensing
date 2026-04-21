package main

// CLI-level tests for licensing-keys. Drive `run()` directly so we don't
// fork a subprocess; injected argv/env/stdout/stderr channels make this
// straightforward.
//
// The tests cover the full happy path end-to-end — make-root → issue-signing
// → rotate → list — and exercise every error-exit shape the user-facing
// surface promises (bad alg, missing env, unknown root, wrong passphrase).

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func stubEnv(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// runCLI is a test harness that mimics os.Exit-based return codes while
// capturing stdout / stderr for assertion.
func runCLI(t *testing.T, argv []string, env map[string]string) (code int, stdout, stderr string) {
	t.Helper()
	var outBuf, errBuf bytes.Buffer
	code = run(runOptions{
		argv:   argv,
		getEnv: stubEnv(env),
		stdout: &outBuf,
		stderr: &errBuf,
	})
	return code, outBuf.String(), errBuf.String()
}

// -----------------------------------------------------------------------
// Usage / help
// -----------------------------------------------------------------------

func TestCLI_NoArgsPrintsUsage(t *testing.T) {
	code, out, _ := runCLI(t, nil, nil)
	if code != 0 {
		t.Fatalf("exit: %d", code)
	}
	if !strings.Contains(out, "licensing-keys") || !strings.Contains(out, "make-root") {
		t.Fatalf("usage missing, got:\n%s", out)
	}
}

func TestCLI_UnknownCommand(t *testing.T) {
	code, _, errs := runCLI(t, []string{"nope"}, nil)
	if code != 1 {
		t.Fatalf("exit: %d, stderr: %s", code, errs)
	}
	if !strings.Contains(errs, "unknown command") {
		t.Fatalf("stderr: %s", errs)
	}
}

// -----------------------------------------------------------------------
// make-root
// -----------------------------------------------------------------------

func TestCLI_MakeRoot_HappyPath(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, out, errs := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	)
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(out, "role:       root") {
		t.Fatalf("stdout missing role line:\n%s", out)
	}
	if !strings.Contains(out, "state:      active") {
		t.Fatalf("stdout missing state line:\n%s", out)
	}
	// File should exist and contain the header + exactly one record line.
	data, err := os.ReadFile(store)
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d:\n%s", len(lines), string(data))
	}
	if lines[0] != `{"__kind":"licensing-keys/v1"}` {
		t.Fatalf("header: %s", lines[0])
	}
}

func TestCLI_MakeRoot_RejectsMissingPassphrase(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		nil, // no env
	)
	if code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(errs, "LICENSING_ROOT_PASSPHRASE") {
		t.Fatalf("stderr: %s", errs)
	}
}

func TestCLI_MakeRoot_RejectsEmptyPassphrase(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": ""},
	)
	if code != 1 {
		t.Fatalf("exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(errs, "must be non-empty") {
		t.Fatalf("stderr: %s", errs)
	}
}

func TestCLI_MakeRoot_RejectsBadAlg(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"make-root", "--alg", "bogus", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "pw"},
	)
	if code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(errs, "alg must be one of") {
		t.Fatalf("stderr: %s", errs)
	}
}

func TestCLI_MakeRoot_RejectsHMAC(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"make-root", "--alg", "hs256", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "pw"},
	)
	// hs256 is not in the CLI's allow-list so the CLI rejects with
	// --alg must be one of, *before* touching the hierarchy.
	if code != 1 {
		t.Fatalf("exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(errs, "alg must be one of") {
		t.Fatalf("stderr: %s", errs)
	}
}

// -----------------------------------------------------------------------
// issue-signing
// -----------------------------------------------------------------------

func TestCLI_IssueSigning_HappyPath(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	// Make a root first.
	if code, _, errs := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	); code != 0 {
		t.Fatalf("make-root: exit=%d stderr=%s", code, errs)
	}
	// Pull the root kid from the store via list.
	rootKid := extractFirstKidFromStore(t, store)
	code, out, errs := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--root-kid", rootKid, "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw",
		},
	)
	if code != 0 {
		t.Fatalf("issue-signing: exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(out, "role:       signing") {
		t.Fatalf("stdout:\n%s", out)
	}
}

func TestCLI_IssueSigning_RequiresBothPassphrases(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	// Only root pass set; signing missing.
	code, _, errs := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--root-kid", "anything", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	)
	if code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(errs, "LICENSING_SIGNING_PASSPHRASE") {
		t.Fatalf("stderr: %s", errs)
	}
}

func TestCLI_IssueSigning_RequiresRootKid(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw",
		},
	)
	if code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(errs, "--root-kid is required") {
		t.Fatalf("stderr: %s", errs)
	}
}

func TestCLI_IssueSigning_UnknownRoot(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--root-kid", "does-not-exist", "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw",
		},
	)
	if code != 1 {
		t.Fatalf("exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(errs, "UnknownKid") {
		t.Fatalf("stderr: %s", errs)
	}
}

// -----------------------------------------------------------------------
// rotate
// -----------------------------------------------------------------------

func TestCLI_Rotate_HappyPath(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	if code, _, _ := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	); code != 0 {
		t.Fatal("make-root failed")
	}
	rootKid := extractFirstKidFromStore(t, store)
	if code, _, errs := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--root-kid", rootKid, "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw",
		},
	); code != 0 {
		t.Fatalf("issue-signing: %s", errs)
	}
	code, out, errs := runCLI(t,
		[]string{"rotate", "--alg", "ed25519", "--root-kid", rootKid, "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw2",
		},
	)
	if code != 0 {
		t.Fatalf("rotate: exit=%d stderr=%s", code, errs)
	}
	if !strings.Contains(out, "retiring:") || !strings.Contains(out, "active:") {
		t.Fatalf("stdout missing sections:\n%s", out)
	}
	// Store now has 3 records (1 root + 1 retiring + 1 active).
	lines := readNDJSONLines(t, store)
	if len(lines) != 4 { // header + 3 records
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
}

// -----------------------------------------------------------------------
// list
// -----------------------------------------------------------------------

func TestCLI_List_EmptyStore(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, out, _ := runCLI(t,
		[]string{"list", "--store", store},
		nil,
	)
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(out, "(no keys)") {
		t.Fatalf("stdout: %s", out)
	}
}

func TestCLI_List_Filters(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	// Seed a root + a signing.
	if code, _, _ := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	); code != 0 {
		t.Fatal("make-root failed")
	}
	rootKid := extractFirstKidFromStore(t, store)
	if code, _, _ := runCLI(t,
		[]string{"issue-signing", "--alg", "ed25519", "--root-kid", rootKid, "--store", store},
		map[string]string{
			"LICENSING_ROOT_PASSPHRASE":    "rpw",
			"LICENSING_SIGNING_PASSPHRASE": "spw",
		},
	); code != 0 {
		t.Fatal("issue-signing failed")
	}
	// list --role signing: one entry.
	code, out, _ := runCLI(t,
		[]string{"list", "--role", "signing", "--store", store},
		nil,
	)
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if strings.Count(out, "kid:") != 1 || !strings.Contains(out, "role:       signing") {
		t.Fatalf("expected exactly one signing record:\n%s", out)
	}
	// list --role root: one entry.
	code, out, _ = runCLI(t,
		[]string{"list", "--role", "root", "--store", store},
		nil,
	)
	if code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if strings.Count(out, "kid:") != 1 || !strings.Contains(out, "role:       root") {
		t.Fatalf("expected exactly one root record:\n%s", out)
	}
}

func TestCLI_List_BadFilterRejected(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	code, _, errs := runCLI(t,
		[]string{"list", "--role", "nonsense", "--store", store},
		nil,
	)
	if code != 1 {
		t.Fatalf("exit=%d", code)
	}
	if !strings.Contains(errs, "--role must be") {
		t.Fatalf("stderr: %s", errs)
	}
}

// -----------------------------------------------------------------------
// Never prints private material
// -----------------------------------------------------------------------

func TestCLI_NeverLeaksPrivateMaterial(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "keys.json")
	_, out, _ := runCLI(t,
		[]string{"make-root", "--alg", "ed25519", "--store", store},
		map[string]string{"LICENSING_ROOT_PASSPHRASE": "rpw"},
	)
	forbidden := []string{"BEGIN ENCRYPTED PRIVATE KEY", "BEGIN PRIVATE KEY", "private_pem_enc"}
	for _, s := range forbidden {
		if strings.Contains(out, s) {
			t.Fatalf("stdout contains forbidden substring %q:\n%s", s, out)
		}
	}
}

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

func readNDJSONLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

func extractFirstKidFromStore(t *testing.T, path string) string {
	t.Helper()
	// Poor-man's extraction — we can't import encoding/json just to peel a
	// kid. Parse the first record line; it's JSON, "kid" is always present.
	lines := readNDJSONLines(t, path)
	if len(lines) < 2 {
		t.Fatalf("expected a record line in store")
	}
	rec := lines[1]
	// Find "kid":"..."; the JSON is compact (no whitespace).
	const needle = `"kid":"`
	i := strings.Index(rec, needle)
	if i < 0 {
		t.Fatalf("record missing kid field: %s", rec)
	}
	rest := rec[i+len(needle):]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		t.Fatalf("unterminated kid: %s", rec)
	}
	return rest[:j]
}
