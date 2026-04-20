/**
 * Minimal OpenAPI 3.1 schema validator — just enough to assert contract
 * conformance on the licensing-admin spec without pulling in `ajv` + the
 * OpenAPI-schema-to-JSON-Schema dance.
 *
 * What we validate:
 *   - `type` (string / number / integer / boolean / object / array / null)
 *   - `required` (object property presence)
 *   - `properties` (recursive validation)
 *   - `additionalProperties: false` (reject unknown keys; default allow)
 *   - `items` (arrays)
 *   - `enum` (membership)
 *   - `const` (strict equality)
 *   - `pattern` (strings)
 *   - `minimum` / `maximum` (numbers)
 *   - `minLength` / `maxLength` (strings)
 *   - `nullable: true` (OpenAPI 3.0 style) and `type: [X, 'null']` (3.1 style)
 *   - `allOf` (combine)
 *   - `$ref` (local `#/components/schemas/...` resolution)
 *
 * Out of scope (not used by our spec): oneOf, anyOf, not, discriminator,
 * externalDocs, remote refs.
 *
 * The validator returns an array of errors (empty = valid). Each error
 * carries a dotted path so test failures are precise.
 */

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

interface Doc {
  readonly components?: { readonly schemas?: Record<string, Schema> };
}

export interface Schema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly nullable?: boolean;
  readonly allOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly description?: string;
}

function resolveRef(doc: Doc, ref: string): Schema {
  // Local refs only: `#/components/schemas/Foo`.
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const name = ref.slice(prefix.length);
  const schemas = doc.components?.schemas;
  const resolved = schemas?.[name];
  if (resolved === undefined) throw new Error(`$ref not found: ${ref}`);
  return resolved;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/** Flatten `allOf` into a single effective schema (merge fields). Only used
 *  with non-conflicting sibling properties, which is the only shape our
 *  OpenAPI document uses (envelope + page merges). */
function flattenAllOf(doc: Doc, schemas: readonly Schema[]): Schema {
  const merged: {
    type?: Schema['type'];
    properties: Record<string, Schema>;
    required: string[];
    additionalProperties?: Schema['additionalProperties'];
    items?: Schema['items'];
  } = { properties: {}, required: [] };
  for (const raw of schemas) {
    const s = raw.$ref !== undefined ? resolveRef(doc, raw.$ref) : raw;
    if (s.type !== undefined) merged.type = s.type;
    if (s.properties !== undefined) Object.assign(merged.properties, s.properties);
    if (s.required !== undefined) merged.required.push(...s.required);
    if (s.additionalProperties !== undefined) merged.additionalProperties = s.additionalProperties;
    if (s.items !== undefined) merged.items = s.items;
  }
  return merged as Schema;
}

function matchesType(v: unknown, expected: string): boolean {
  if (expected === 'integer') return Number.isInteger(v);
  if (expected === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (expected === 'null') return v === null;
  return typeOf(v) === expected;
}

export function validate(doc: Doc, schema: Schema, value: unknown, path = ''): ValidationError[] {
  // Resolve $ref first.
  if (schema.$ref !== undefined) {
    try {
      return validate(doc, resolveRef(doc, schema.$ref), value, path);
    } catch (e) {
      return [{ path, message: (e as Error).message }];
    }
  }

  // allOf → flatten and validate against the merge.
  if (schema.allOf !== undefined && schema.allOf.length > 0) {
    return validate(doc, flattenAllOf(doc, schema.allOf), value, path);
  }

  const errors: ValidationError[] = [];

  // Nullability: OpenAPI 3.0 uses `nullable: true`; 3.1 uses type array
  // with 'null'. Support both.
  const nullable =
    schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
  if (value === null) {
    if (nullable) return errors;
    // Fall through — the type check below will catch it unless type is 'null'.
  }

  // Type check.
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const nonNullTypes = types.filter((t) => t !== 'null');
    if (value === null) {
      if (!types.includes('null') && !nullable) {
        errors.push({ path, message: `expected ${types.join('|')}, got null` });
      }
    } else {
      const matched = nonNullTypes.some((t) => matchesType(value, t));
      if (!matched) {
        errors.push({
          path,
          message: `expected ${nonNullTypes.join('|')}, got ${typeOf(value)}`,
        });
        return errors; // Further checks don't make sense once type is wrong.
      }
    }
  }

  // Const.
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected const ${String(schema.const)}, got ${String(value)}` });
  }

  // Enum.
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push({
      path,
      message: `expected one of [${schema.enum.map(String).join(', ')}], got ${String(value)}`,
    });
  }

  // String constraints.
  if (typeof value === 'string') {
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push({
          path,
          message: `pattern /${schema.pattern}/ did not match ${JSON.stringify(value)}`,
        });
      }
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `minLength ${schema.minLength}, got ${value.length}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `maxLength ${schema.maxLength}, got ${value.length}` });
    }
  }

  // Number constraints.
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `minimum ${schema.minimum}, got ${value}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `maximum ${schema.maximum}, got ${value}` });
    }
  }

  // Object shape.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        errors.push({ path: path || '<root>', message: `missing required property: ${key}` });
      }
    }

    // Unknown-property rejection. `additionalProperties === false` means
    // reject; `true` or a Schema means pass (we don't validate extras deeper
    // since the OpenAPI document never uses that shape).
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          errors.push({ path: path || '<root>', message: `unknown property: ${key}` });
        }
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        errors.push(...validate(doc, sub, obj[key], path === '' ? key : `${path}.${key}`));
      }
    }
  }

  // Array items.
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validate(doc, schema.items, value[i], `${path}[${i}]`));
    }
  }

  return errors;
}
