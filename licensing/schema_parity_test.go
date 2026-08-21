package licensing

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Schema parity against the normative fixture.
//
// schema.go and storage.go both claim "a conformance test asserts parity
// against fixtures/schema/entities.md" and "the parity test compares
// strings". No Go test read that file — the comments described a test that
// existed only in TypeScript.
//
// The storage conformance suite's testSchemaCanonical is not that test
// either: every adapter implements DescribeSchema as `return
// CanonicalSchema()`, so it compares a function against itself and passes
// no matter what the fixture or the migrations say.
//
// This test parses the fixture's markdown tables and compares them to
// CanonicalSchema(), so drift between the normative document and the Go
// code fails here.

// entityHeading matches "## 1. License" and captures the entity name.
// Headings may carry a parenthetical gloss — "## 5. LicenseKey (signing key
// storage)" — which is not part of the entity name.
var entityHeading = regexp.MustCompile(`^##\s+\d+\.\s+([A-Za-z]+)`)

// parsedEntity is one entity section of the fixture.
type parsedEntity struct {
	Name    string
	Columns []parsedColumn
}

type parsedColumn struct {
	Name     string
	Nullable bool
}

// parseEntitiesFixture reads fixtures/schema/entities.md and extracts each
// "## N. EntityName" section's field table. Only the field name and the
// Nullable? column are extracted — the Type column uses prose ("string (≤
// 128 chars)", "uuid v7") that does not map 1:1 onto SchemaColumnType, and
// inventing a mapping here would make this test assert the mapping rather
// than the schema.
func parseEntitiesFixture(t *testing.T) []parsedEntity {
	t.Helper()
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "fixtures", "schema", "entities.md"))
	if err != nil {
		t.Fatalf("reading entities.md: %v", err)
	}

	var out []parsedEntity
	var cur *parsedEntity
	for _, line := range strings.Split(string(raw), "\n") {
		if m := entityHeading.FindStringSubmatch(line); m != nil {
			if cur != nil {
				out = append(out, *cur)
			}
			cur = &parsedEntity{Name: strings.TrimSpace(m[1])}
			continue
		}
		if cur == nil || !strings.HasPrefix(strings.TrimSpace(line), "|") {
			continue
		}
		cells := strings.Split(strings.Trim(strings.TrimSpace(line), "|"), "|")
		if len(cells) < 3 {
			continue
		}
		name := strings.Trim(strings.TrimSpace(cells[0]), "`")
		// Skip the header row and the |---|---| separator.
		if name == "" || name == "Field" || strings.HasPrefix(name, "---") {
			continue
		}
		nullable := strings.EqualFold(strings.TrimSpace(cells[2]), "yes")
		cur.Columns = append(cur.Columns, parsedColumn{Name: name, Nullable: nullable})
	}
	if cur != nil {
		out = append(out, *cur)
	}
	return out
}

func TestCanonicalSchema_MatchesEntitiesFixture(t *testing.T) {
	parsed := parseEntitiesFixture(t)
	if len(parsed) == 0 {
		t.Fatal("parsed no entities from entities.md — the parser or the fixture layout changed")
	}

	byName := map[string]parsedEntity{}
	for _, e := range parsed {
		byName[e.Name] = e
	}

	canonical := CanonicalSchema()
	if len(canonical) == 0 {
		t.Fatal("CanonicalSchema() is empty")
	}

	for _, ent := range canonical {
		fixture, ok := byName[string(ent.Name)]
		if !ok {
			t.Errorf("entity %s is in CanonicalSchema() but has no section in entities.md", ent.Name)
			continue
		}

		fixtureCols := map[string]parsedColumn{}
		for _, c := range fixture.Columns {
			fixtureCols[c.Name] = c
		}

		for _, col := range ent.Columns {
			fc, ok := fixtureCols[col.Name]
			if !ok {
				t.Errorf("%s.%s is in CanonicalSchema() but not in entities.md", ent.Name, col.Name)
				continue
			}
			if fc.Nullable != col.Nullable {
				t.Errorf("%s.%s nullability: CanonicalSchema()=%v entities.md=%v",
					ent.Name, col.Name, col.Nullable, fc.Nullable)
			}
			delete(fixtureCols, col.Name)
		}

		for name := range fixtureCols {
			t.Errorf("%s.%s is documented in entities.md but missing from CanonicalSchema()",
				ent.Name, name)
		}
	}
}

// The adapters all return CanonicalSchema() verbatim, so the conformance
// suite's parity check cannot detect drift on its own. This records that
// the canonical description is the single source both ports compare to, and
// fails loudly if an entity is dropped from it.
func TestCanonicalSchema_CoversEveryDeclaredEntity(t *testing.T) {
	want := []SchemaEntityName{
		SchemaEntLicense,
		SchemaEntLicenseScope,
		SchemaEntLicenseTemplate,
		SchemaEntLicenseUsage,
		SchemaEntLicenseKey,
		SchemaEntAuditLog,
		SchemaEntTrialIssuance,
	}
	got := map[SchemaEntityName]bool{}
	for _, e := range CanonicalSchema() {
		got[e.Name] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("entity %s is declared as a SchemaEntityName but absent from CanonicalSchema()", name)
		}
	}
}
