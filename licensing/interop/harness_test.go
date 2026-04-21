package interop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// repoRoot walks up from this file's directory until it finds the top-level
// marker files. Cached after first call because every test needs it.
func repoRoot(t testing.TB) string {
	t.Helper()
	once.Do(func() {
		_, thisFile, _, ok := runtime.Caller(0)
		if !ok {
			cachedErr = errors.New("runtime.Caller failed")
			return
		}
		dir := filepath.Dir(thisFile)
		for i := 0; i < 10; i++ {
			if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
				if _, err := os.Stat(filepath.Join(dir, "fixtures")); err == nil {
					cachedRoot = dir
					return
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				cachedErr = errors.New("could not find repo root (package.json + fixtures) above " + filepath.Dir(thisFile))
				return
			}
			dir = parent
		}
		cachedErr = errors.New("repo-root search exhausted depth")
	})
	if cachedErr != nil {
		t.Fatalf("repoRoot: %v", cachedErr)
	}
	return cachedRoot
}

var (
	once       sync.Once
	cachedRoot string
	cachedErr  error
)

// requireBun skips the test if bun is not on PATH. CI is expected to have
// it — but this keeps `go test ./...` viable for Go-only contributors.
func requireBun(t testing.TB) {
	t.Helper()
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skipf("bun not on PATH; skipping interop test (install bun to run)")
	}
}

// cliResult is the on-the-wire shape every interop-* script emits.
type cliResult struct {
	Error string          `json:"error,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
	Ok    bool            `json:"ok"`
}

// runBunCLI invokes one of the TS helper scripts with JSON on stdin and
// parses the (single) JSON response on stdout. stderr is captured and
// attached to the test log on failure so TS-side crashes are diagnosable.
//
// The timeout defaults to 60s — RSA key import dominates the cost on a
// cold run; steady-state the scripts complete in tens of milliseconds.
func runBunCLI(t testing.TB, script string, input any) (json.RawMessage, error) {
	t.Helper()
	root := repoRoot(t)
	scriptPath := filepath.Join(root, "tools", "interop", "bin", script)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	payload, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, "bun", scriptPath)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	// Even on exit-code 1 the CLIs emit a structured {ok:false} envelope on
	// stdout — parse first, then use stderr to enrich the error if decode
	// also fails.
	var res cliResult
	if decErr := json.Unmarshal(stdout.Bytes(), &res); decErr != nil {
		return nil, &bunError{script: script, stderr: stderr.String(), runErr: runErr, decodeErr: decErr, stdout: stdout.String()}
	}
	if !res.Ok {
		return nil, &bunError{script: script, stderr: stderr.String(), runErr: runErr, message: res.Error}
	}
	return res.Value, nil
}

type bunError struct {
	runErr    error
	decodeErr error
	script    string
	stderr    string
	stdout    string
	message   string
}

func (e *bunError) Error() string {
	msg := e.message
	if msg == "" && e.decodeErr != nil {
		msg = "invalid JSON on stdout: " + e.decodeErr.Error() + " stdout=" + e.stdout
	}
	if msg == "" && e.runErr != nil {
		msg = e.runErr.Error()
	}
	out := e.script + ": " + msg
	if e.stderr != "" {
		out += "\nstderr: " + sanitizeCLIStream(e.stderr)
	}
	return out
}

// sanitizeCLIStream trims and redacts CLI error streams before they land
// in test logs. Two concerns:
//   - CI logs are retained (and public on OSS PRs) — an oversized paste
//     makes failures unreadable. Cap at 2 KiB.
//   - The interop CLIs handle private key material. `tools/interop/src/io.ts`
//     forbids writing secrets to stderr, but a future debug console.error
//     could accidentally echo a PEM block — strip anything that looks like
//     one before it surfaces.
func sanitizeCLIStream(s string) string {
	const maxLen = 2048
	// Strip PEM blocks (private or public — conservative; PEM in stderr is
	// a logging smell regardless of its half).
	if idx := strings.Index(s, "-----BEGIN "); idx >= 0 {
		end := strings.Index(s[idx:], "-----END ")
		if end >= 0 {
			tail := strings.Index(s[idx+end:], "-----")
			if tail >= 0 {
				s = s[:idx] + "[REDACTED PEM BLOCK]" + s[idx+end+tail+5:]
			}
		}
	}
	if len(s) > maxLen {
		s = s[:maxLen] + "...[truncated]"
	}
	return s
}
