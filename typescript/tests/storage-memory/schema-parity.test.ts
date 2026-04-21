/**
 * Schema-parity test.
 *
 * Parses `fixtures/schema/entities.md` and asserts that the memory
 * adapter's `describeSchema()` surfaces every field listed, with matching
 * type category, nullability, and uniqueness membership.
 *
 * The parser is intentionally strict: any divergence between the markdown
 * and the adapter (missing field, different type category, different
 * nullability, missing unique constraint) fails the test with a message
 * pointing at the offending entity + field.
 *
 * Type-category mapping from the markdown's human-written type column to
 * our `SchemaColumn.type` discriminator:
 *   - "uuid v7"             → uuid
 *   - "string (…)" or "string" → string
 *   - "int (…)" or "int"    → int
 *   - "timestamptz"         → timestamp
 *   - "enum"                → enum
 *   - "json" / "json object" → json
 *   - "text"                → text
 *
 * Uniqueness parsing:
 *   The "Unique?" column can say "yes (PK)", "yes (single)", "yes",
 *   composite descriptors from the §Uniqueness prose below each table,
 *   or "—". The markdown uses English prose for composite unique constraints;
 *   we parse the prose to extract which columns participate in which named
 *   constraint. Constraint names in the adapter are adapter-chosen (e.g.
 *   `licensable_scope`); parity asserts *membership*, not name-equality.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SchemaColumn, SchemaDescription, SchemaEntity } from '@anorebel/licensing/storage';

import { MemoryStorage } from '../../src/storage/memory/index.ts';

const FIXTURES_SCHEMA = join(import.meta.dir, '../../../fixtures/schema/entities.md');

type EntityName = SchemaEntity['name'];

// ---------- Markdown parser ----------

interface ParsedColumn {
  readonly name: string;
  readonly type: SchemaColumn['type'];
  readonly nullable: boolean;
  /** True if the row's "Unique?" cell mentions uniqueness (single-column). */
  readonly singleUnique: boolean;
  /** True if the cell mentions "composite below" or similar. */
  readonly compositeUnique: boolean;
}

interface ParsedEntity {
  readonly name: EntityName;
  readonly columns: readonly ParsedColumn[];
  /** Composite-unique groups parsed from the §Uniqueness prose: each group
   *  is the set of column names participating in one named constraint. */
  readonly compositeGroups: readonly (readonly string[])[];
}

const SECTION_TO_ENTITY: Record<string, EntityName> = {
  License: 'License',
  LicenseScope: 'LicenseScope',
  LicenseTemplate: 'LicenseTemplate',
  LicenseUsage: 'LicenseUsage',
  LicenseKey: 'LicenseKey',
  AuditLog: 'AuditLog',
};

function parseType(raw: string): SchemaColumn['type'] {
  const t = raw.trim().toLowerCase();
  if (t.startsWith('uuid')) return 'uuid';
  if (t.startsWith('string')) return 'string';
  if (t.startsWith('int')) return 'int';
  if (t.startsWith('timestamptz') || t.startsWith('timestamp')) return 'timestamp';
  if (t.startsWith('json')) return 'json';
  if (t === 'enum') return 'enum';
  if (t === 'text') return 'text';
  throw new Error(`unknown type category: ${raw}`);
}

function parseNullable(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'no') return false;
  if (v === 'yes') return true;
  throw new Error(`unknown nullability: ${raw}`);
}

/** Parse a "Unique?" cell. Returns which uniqueness flavor(s) the cell implies. */
function parseUniqueCell(raw: string): { single: boolean; composite: boolean } {
  const v = raw.trim().toLowerCase();
  if (v === '—' || v === '-' || v === '') return { single: false, composite: false };
  if (v.includes('composite below')) return { single: false, composite: true };
  if (v.includes('yes')) return { single: true, composite: false };
  return { single: false, composite: false };
}

function parseEntities(md: string): readonly ParsedEntity[] {
  const lines = md.split('\n');
  const entities: ParsedEntity[] = [];

  // Walk section-by-section: each "## N. EntityName" starts a block.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // "## 1. License" or "## 5. LicenseKey (signing key storage)" — we
    // only care about the first word after the section number.
    const m = line.match(/^## \d+\. (\w+)/);
    if (!m) continue;
    const sectionTitle = m[1] as string;
    const entityName = SECTION_TO_ENTITY[sectionTitle];
    if (!entityName) continue; // skip non-entity sections (e.g. "Cross-adapter expectations")

    // Find the first table row (starts with `| Field` or `|---`), then read
    // rows until a blank line or the next `##` / `---` separator.
    const cols: ParsedColumn[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] as string;
      if (l.startsWith('## ')) break;
      if (l.startsWith('| `')) {
        // Table data row.
        const cells = splitRow(l);
        if (cells.length >= 4) {
          const name = (cells[0] as string).replace(/`/g, '').trim();
          const type = parseType(cells[1] as string);
          const nullable = parseNullable(cells[2] as string);
          const { single, composite } = parseUniqueCell(cells[3] as string);
          cols.push({
            name,
            type,
            nullable,
            singleUnique: single,
            compositeUnique: composite,
          });
        }
      }
      j++;
    }

    // Now scan forward for a "Uniqueness:" block describing composite groups.
    const compositeGroups: string[][] = [];
    let k = i + 1;
    while (k < lines.length) {
      const l = lines[k] as string;
      if (l.startsWith('## ')) break;
      if (/^Uniqueness:\s*$/.test(l)) {
        // Consume subsequent `- \`(col, col, …)\` …` bullets until a blank
        // or separator.
        let m2 = k + 1;
        while (m2 < lines.length) {
          const bulletLine = lines[m2] as string;
          if (!bulletLine.startsWith('-')) {
            if (bulletLine.trim() === '' || bulletLine.startsWith('##')) break;
            // Continuation text (descriptions wrap). Skip.
            m2++;
            continue;
          }
          // Look for "(col, col, …)" anywhere in a backticked span on the
          // bullet. The span may be `(a, b)` (pure tuple) or `(a, b) WHERE …`
          // (partial-unique with predicate), so we match the first `(…)`
          // inside any backticked region.
          const tupleMatch = bulletLine.match(/`[^`]*?\(([^)]+)\)[^`]*`/);
          if (tupleMatch) {
            const group = (tupleMatch[1] as string)
              .split(',')
              .map((s) => s.trim().replace(/`/g, ''));
            compositeGroups.push(group);
          }
          m2++;
        }
      }
      k++;
    }

    entities.push({
      name: entityName,
      columns: cols,
      compositeGroups,
    });
    i = j - 1;
  }

  return entities;
}

/** Split a pipe-table row into cells, trimming borders. */
function splitRow(line: string): string[] {
  // Drop the leading/trailing `|`.
  const body = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  return body.split('|').map((c) => c.trim());
}

// ---------- The actual assertions ----------

describe('schema parity — memory adapter vs fixtures/schema/entities.md', () => {
  const md = readFileSync(FIXTURES_SCHEMA, 'utf8');
  const parsed = parseEntities(md);
  const adapter = new MemoryStorage();
  const described: SchemaDescription = adapter.describeSchema();

  // Sanity: both sides enumerate the same six entities.
  it('covers every canonical entity', () => {
    const parsedNames = parsed.map((e) => e.name).sort();
    const describedNames = described.map((e) => e.name).sort();
    expect(parsedNames).toEqual(describedNames);
    expect(parsedNames).toEqual([
      'AuditLog',
      'License',
      'LicenseKey',
      'LicenseScope',
      'LicenseTemplate',
      'LicenseUsage',
    ]);
  });

  // Per-entity assertions.
  for (const spec of parsed) {
    describe(`entity ${spec.name}`, () => {
      const actual = described.find((e) => e.name === spec.name);
      // Any column that appears in ANY parsed composite group is composite-
      // unique *by the prose*, regardless of what the cell-level "Unique?"
      // column said. The table cell and the prose can disagree (e.g.
      // LicenseTemplate marks `scope_id`/`name` as `—` in the cell but lists
      // them in a composite group below). The prose is authoritative — it's
      // what the adapter implements.
      const proseCompositeMembers = new Set<string>(spec.compositeGroups.flat());

      it('exists in adapter describeSchema()', () => {
        expect(actual).toBeDefined();
      });

      if (!actual) return;

      it('reports the same set of column names', () => {
        const specCols = spec.columns.map((c) => c.name).sort();
        const actualCols = actual.columns.map((c) => c.name).sort();
        expect(actualCols).toEqual(specCols);
      });

      for (const specCol of spec.columns) {
        it(`field ${specCol.name}: type + nullability match`, () => {
          const actualCol = actual.columns.find((c) => c.name === specCol.name);
          expect(actualCol).toBeDefined();
          if (!actualCol) return;
          expect(actualCol.type).toBe(specCol.type);
          expect(actualCol.nullable).toBe(specCol.nullable);
        });

        it(`field ${specCol.name}: uniqueness membership matches`, () => {
          const actualCol = actual.columns.find((c) => c.name === specCol.name);
          if (!actualCol) return;
          const inComposite = specCol.compositeUnique || proseCompositeMembers.has(specCol.name);
          // Single-unique field — adapter must report AT LEAST one
          // non-'pk' constraint (or a `pk` constraint for the id column).
          if (specCol.singleUnique) {
            expect(actualCol.unique.length).toBeGreaterThan(0);
          }
          // Composite membership — adapter must report at least one
          // constraint AND the column must appear in one of the parsed
          // composite groups.
          if (inComposite) {
            expect(actualCol.unique.length).toBeGreaterThan(0);
            const groupsContaining = spec.compositeGroups.filter((g) => g.includes(specCol.name));
            expect(groupsContaining.length).toBeGreaterThan(0);
          }
          // Non-unique field AND column doesn't appear in any composite
          // group — adapter MUST NOT report any uniqueness constraint for
          // this column (except the `pk` marker, which is fine on id).
          if (!specCol.singleUnique && !inComposite) {
            const nonPk = actualCol.unique.filter((u) => u !== 'pk');
            expect(nonPk).toEqual([]);
          }
        });
      }

      // Composite-group parity: for each parsed composite group, the adapter
      // must report at least one shared constraint name across all columns
      // in the group.
      for (const group of spec.compositeGroups) {
        // Single-column "composite groups" (e.g. a `license_key` bullet that
        // only lists one column) are really single uniques — skip them here.
        if (group.length < 2) continue;
        it(`composite uniqueness (${group.join(', ')}) — all members share a constraint`, () => {
          const memberConstraints = group.map((colName) => {
            const c = actual.columns.find((x) => x.name === colName);
            return new Set(c?.unique ?? []);
          });
          // Intersect all member sets; at least one non-'pk' entry must be
          // common to every member.
          const first = memberConstraints[0];
          if (!first) return;
          const shared = [...first].filter(
            (name) => name !== 'pk' && memberConstraints.every((s) => s.has(name)),
          );
          expect(shared.length).toBeGreaterThan(0);
        });
      }
    });
  }
});
