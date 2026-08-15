import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Builds stub responses *from* `openapi/licensing-admin.yaml` rather than
 * hand-writing them.
 *
 * A hand-written stub is a second, silent copy of the contract: when the spec
 * gains a required field the stub keeps returning the old shape, the smoke
 * checks keep passing, and the drift is only found in production. Generating
 * the payloads from the spec makes that impossible — if a required property
 * appears, it appears here too.
 *
 * This is a *shape* generator, not a full JSON-Schema faker. It resolves
 * `$ref` and `allOf` and emits a schema-valid value for every required
 * property, honouring `enum`, `format`, `nullable`, and `pattern` where the
 * pattern is simple enough to matter (slugs). Values are deterministic:
 * seeded by property path, so the same field is the same value on every run
 * and row order never shifts between runs.
 */

const SPEC_PATH = fileURLToPath(new URL('../../../openapi/licensing-admin.yaml', import.meta.url));

/**
 * A node in the OpenAPI document. Deliberately loose — we walk an arbitrary
 * schema tree, so every property access is checked at the point of use
 * rather than by a hand-maintained mirror of the OpenAPI meta-schema.
 */
type Schema = { [key: string]: SchemaValue };
type SchemaValue = string | number | boolean | null | undefined | Schema | SchemaValue[];

const spec: Schema = parse(readFileSync(SPEC_PATH, 'utf8'));

/** Resolves a local `#/components/...` pointer. */
function deref(node: Schema): Schema {
  let cur = node;
  // Chains are legal (`$ref` -> `$ref`), so loop rather than resolve once.
  while (cur?.$ref) {
    const path = String(cur.$ref).replace(/^#\//, '').split('/');
    let target: Schema = spec;
    for (const seg of path) target = target?.[seg];
    if (!target) throw new Error(`Unresolvable $ref: ${cur.$ref}`);
    cur = target;
  }
  return cur;
}

/** Flattens `allOf` into a single object schema. */
function flatten(schema: Schema): Schema {
  const s = deref(schema);
  if (!s.allOf) return s;
  const out: Schema = { type: 'object', properties: {}, required: [] };
  for (const part of s.allOf) {
    const p = flatten(part);
    Object.assign(out.properties, p.properties ?? {});
    out.required.push(...(p.required ?? []));
  }
  return out;
}

/**
 * Deterministic per-path value. Using the property path as the seed keeps
 * output stable across runs without a PRNG, which matters because the smoke
 * checks assert on exact rendered text.
 */
function seededInt(path: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % mod;
}

const UUID_NS = '00000000-0000-4000-8000-';
const FIXED_TIME = '2026-06-01T00:00:00.000Z';

function scalarFor(schema: Schema, path: string, index: number): unknown {
  const s = deref(schema);

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    // Spread enum values across rows so faceted filters have something to
    // actually partition — a column of identical values cannot be tested.
    return s.enum[index % s.enum.length];
  }

  switch (s.type) {
    case 'integer':
      return seededInt(path, 20) + 1;
    case 'number':
      return seededInt(path, 100) / 10;
    case 'boolean':
      return index % 2 === 0;
    case 'array':
      return s.items ? [valueFor(s.items, `${path}[0]`, index)] : [];
    case 'object':
      return buildObject(s, path, index);
    default: {
      if (s.format === 'uuid') {
        return `${UUID_NS}${String(index + 1).padStart(12, '0')}`;
      }
      if (s.format === 'date-time') return FIXED_TIME;
      // Slug-shaped fields must satisfy `^[a-z0-9][a-z0-9-]*$`; a generic
      // string would render but fail the contract the UI links against.
      //
      // The prefixes are deliberately NOT in ascending order: a sort
      // assertion against pre-sorted data passes without sorting ever
      // running, so the fixture has to arrive shuffled to be meaningful.
      if (typeof s.pattern === 'string' && s.pattern.includes('a-z0-9')) {
        return `${['zeta', 'alpha', 'mike'][index % 3]}-${path.split('.').pop()}`;
      }
      return `${path.split('.').pop()}-${index + 1}`;
    }
  }
}

function valueFor(schema: Schema, path: string, index: number): unknown {
  const s = deref(schema);
  // Prefer a concrete value over null even where nullable — a null renders
  // as an em-dash placeholder, which makes row assertions meaningless.
  if (s.allOf) return buildObject(flatten(s), path, index);
  return scalarFor(s, path, index);
}

function buildObject(schema: Schema, path: string, index: number): Record<string, unknown> {
  const s = flatten(schema);
  const out: Record<string, unknown> = {};
  const required: string[] = s.required ?? [];
  for (const key of required) {
    const propSchema = s.properties?.[key];
    if (!propSchema) continue;
    out[key] = valueFor(propSchema, `${path}.${key}`, index);
  }
  return out;
}

/** Resolves the 200 response schema for `GET <path>`. */
function responseSchemaFor(apiPath: string): Schema {
  const op = spec.paths?.[apiPath]?.get;
  if (!op) throw new Error(`No GET operation in the spec for ${apiPath}`);
  const schema = op.responses?.['200']?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`No 200 JSON schema for GET ${apiPath}`);
  return schema;
}

/**
 * Builds a list envelope for `GET <path>` with `count` items, straight from
 * the spec's own envelope + item schemas.
 */
export function listResponseFor(apiPath: string, count: number): Record<string, unknown> {
  const env = flatten(responseSchemaFor(apiPath));
  const dataSchema = flatten(env.properties?.data ?? {});
  const itemSchema = dataSchema.properties?.items?.items;
  if (!itemSchema) throw new Error(`No items schema for GET ${apiPath}`);

  const items = Array.from({ length: count }, (_, i) =>
    buildObject(flatten(itemSchema), apiPath, i),
  );
  return { success: true, data: { items, next_cursor: null } };
}

/** Builds a non-list (object) response, e.g. `/admin/stats/licenses`. */
export function objectResponseFor(apiPath: string): Record<string, unknown> {
  const env = flatten(responseSchemaFor(apiPath));
  const dataSchema = env.properties?.data;
  if (!dataSchema) throw new Error(`No data schema for GET ${apiPath}`);
  return { success: true, data: buildObject(flatten(dataSchema), apiPath, 0) };
}

/** The item-level required properties the spec declares, for assertions. */
export function requiredPropsFor(apiPath: string): string[] {
  const env = flatten(responseSchemaFor(apiPath));
  const dataSchema = flatten(env.properties?.data ?? {});
  const itemSchema = dataSchema.properties?.items?.items;
  return itemSchema ? (flatten(itemSchema).required ?? []) : [];
}
