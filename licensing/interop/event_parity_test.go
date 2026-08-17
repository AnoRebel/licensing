package interop

// Audit event vocabulary parity.
//
// docs/events.md long claimed "the interop test that round-trips the audit
// log across ports will pick up the new event automatically" — no such test
// existed. This is the test that claim should have described.
//
// It deliberately does NOT round-trip audit rows. Audit rows are written to
// a database by whichever port is running; they are never exchanged between
// ports, so a round-trip would prove nothing about byte compatibility. What
// CAN drift is the shared vocabulary: one port renaming or adding an event
// the other does not emit. That is what this checks.
//
// fixtures/events/canonical.json is the source of truth. `emitted` names
// must appear in both ports' source; `reserved` names are documented but
// intentionally unimplemented, and must appear in NEITHER — that keeps a
// reserved string from being quietly repurposed.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

type eventFixture struct {
	Emitted  []string `json:"emitted"`
	Reserved []string `json:"reserved"`
}

// eventLiteral matches an audit event name in either language's quoting.
//
// Matched broadly on purpose. An earlier version enumerated the known verbs
// to dodge false positives, which silently blinded the test to exactly what
// it exists to catch: a NEW verb appearing in one port only. Broad match
// plus an explicit exclusion list fails loudly on the unknown instead.
var eventLiteral = regexp.MustCompile(`["'](key|license|scope|template|trial|usage)\.[a-z_]+["']`)

// notEvents are strings that share the `<entity>.<word>` shape but are not
// audit events. Keep this list minimal and justified — every entry is a
// place the parity check is deliberately blind.
var notEvents = map[string]bool{
	// Unique-constraint identifier surfaced in UniqueConstraintViolation.
	"scope.slug": true,
}

// scanEmitted walks a source tree and collects every audit-event string
// literal, skipping tests and fixtures so only real emitters count.
func scanEmitted(t *testing.T, root string, exts ...string) map[string]bool {
	t.Helper()
	found := map[string]bool{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			base := filepath.Base(path)
			if base == "node_modules" || base == "dist" || base == ".nuxt" || base == "tests" {
				return filepath.SkipDir
			}
			return nil
		}
		// A test may reference an event it does not emit (e.g. asserting a
		// filter), so tests would produce false positives.
		if strings.HasSuffix(path, "_test.go") || strings.Contains(path, ".test.") {
			return nil
		}
		ok := false
		for _, e := range exts {
			if strings.HasSuffix(path, e) {
				ok = true
				break
			}
		}
		if !ok {
			return nil
		}
		b, err := os.ReadFile(path) //nolint:gosec // test-only, path from filepath.Walk
		if err != nil {
			return err
		}
		for _, m := range eventLiteral.FindAllString(string(b), -1) {
			name := strings.Trim(m, `"'`)
			if notEvents[name] {
				continue
			}
			found[name] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return found
}

func TestAuditEventVocabularyParity(t *testing.T) {
	root := repoRoot(t)

	raw, err := os.ReadFile(filepath.Join(root, "fixtures", "events", "canonical.json"))
	if err != nil {
		t.Fatalf("read fixtures/events/canonical.json: %v", err)
	}
	var fx eventFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse event fixture: %v", err)
	}
	if len(fx.Emitted) == 0 {
		t.Fatal("fixture lists no emitted events")
	}

	goEvents := scanEmitted(t, filepath.Join(root, "licensing"), ".go")
	tsEvents := scanEmitted(t, filepath.Join(root, "typescript", "src"), ".ts")

	for _, ev := range fx.Emitted {
		if !goEvents[ev] {
			t.Errorf("event %q is declared emitted but no Go emitter was found", ev)
		}
		if !tsEvents[ev] {
			t.Errorf("event %q is declared emitted but no TypeScript emitter was found", ev)
		}
	}

	// A reserved name must stay unimplemented in BOTH ports. If one port
	// starts emitting it, the fixture is stale and the ports have drifted.
	for _, ev := range fx.Reserved {
		if goEvents[ev] {
			t.Errorf("event %q is reserved but Go emits it — move it to `emitted` and add the TS emitter", ev)
		}
		if tsEvents[ev] {
			t.Errorf("event %q is reserved but TypeScript emits it — move it to `emitted` and add the Go emitter", ev)
		}
	}

	// Anything a port emits that the fixture does not know about is drift in
	// the other direction: an undocumented event.
	known := map[string]bool{}
	for _, ev := range append(append([]string{}, fx.Emitted...), fx.Reserved...) {
		known[ev] = true
	}
	var undocumented []string
	for ev := range goEvents {
		if !known[ev] {
			undocumented = append(undocumented, "go:"+ev)
		}
	}
	for ev := range tsEvents {
		if !known[ev] {
			undocumented = append(undocumented, "ts:"+ev)
		}
	}
	if len(undocumented) > 0 {
		sort.Strings(undocumented)
		t.Errorf("events emitted but absent from fixtures/events/canonical.json: %v\n"+
			"Add them to the fixture and docs/events.md, or stop emitting them.", undocumented)
	}
}
