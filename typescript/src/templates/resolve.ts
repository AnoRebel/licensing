/**
 * Template inheritance resolver.
 *
 * Walks the parent chain of a `LicenseTemplate` from leaf to root and merges
 * `entitlements` and `meta` with **child-wins deep-merge** semantics. Other
 * inheritable fields (`max_usages`, `trial_duration_sec`, `trial_cooldown_sec`,
 * `grace_duration_sec`, `force_online_after_sec`) are taken from the leaf
 * directly — they are NOT NULL by schema (modulo `force_online_after_sec` and
 * `trial_cooldown_sec` which may be null at the leaf and stay null). The
 * resolver does NOT relax NOT NULL on inheritable fields; child rows must
 * always be self-sufficient. Inheritance is an admin convenience layered over
 * the existing model.
 *
 * Walk depth caps at `MAX_DEPTH = 5` ancestors. Beyond that we emit a single
 * warning naming the leaf and the chain length, then stop walking. The
 * resolved license still issues with whatever was assembled up to that point.
 *
 * Cycles are rejected at write time by the storage adapter (see
 * `errors.templateCycle`); the resolver assumes the chain is acyclic. As an
 * additional safety net, it tracks visited ids and bails immediately on a
 * revisit — emitting a warning rather than throwing, since this is the
 * inheritance read path, not a write path, and we never want to deadlock
 * a token issuance on a corrupted tree.
 */

import type { JSONValue, LicenseTemplate, UUIDv7 } from '../types.ts';

/** Maximum number of ancestor links the resolver walks. Beyond this we log
 *  a warning and use whatever we've assembled so far. */
export const MAX_TEMPLATE_DEPTH = 5;

/** Logger surface the resolver uses for depth-limit and cycle warnings. The
 *  default is `console.warn` so callers don't have to wire one up; tests
 *  swap it out via {@link resolveTemplate}. */
export interface ResolveLogger {
  warn: (message: string, details?: Record<string, unknown>) => void;
}

const defaultLogger: ResolveLogger = {
  warn: (message, details) => {
    if (details === undefined) console.warn(`[licensing/templates] ${message}`);
    else console.warn(`[licensing/templates] ${message}`, details);
  },
};

/** A subset of `LicenseTemplate` covering exactly the resolver's outputs. */
export interface ResolvedTemplate {
  readonly id: UUIDv7;
  readonly scope_id: UUIDv7 | null;
  readonly parent_id: UUIDv7 | null;
  readonly name: string;
  readonly max_usages: number;
  readonly trial_duration_sec: number;
  readonly trial_cooldown_sec: number | null;
  readonly grace_duration_sec: number;
  readonly force_online_after_sec: number | null;
  readonly entitlements: Readonly<Record<string, JSONValue>>;
  readonly meta: Readonly<Record<string, JSONValue>>;
  /** Number of ancestor templates merged into this result (zero for a flat template). */
  readonly inheritedDepth: number;
  /** True when the walker hit the depth cap before reaching the root. */
  readonly truncated: boolean;
}

/** Function shape that loads a template by id. Returns null when missing. */
export type TemplateLoader = (id: UUIDv7) => Promise<LicenseTemplate | null>;

/**
 * Resolve `leaf`'s effective `entitlements` and `meta` by walking its
 * parent chain. Other fields are passed through from `leaf` unchanged.
 *
 * The walker uses the `loader` callback to fetch each ancestor. Callers
 * typically wire it to the storage adapter's `getTemplate(id)`.
 */
export async function resolveTemplate(
  leaf: LicenseTemplate,
  loader: TemplateLoader,
  logger: ResolveLogger = defaultLogger,
): Promise<ResolvedTemplate> {
  // Collect ancestor templates in walk order (closest parent first).
  const chain: LicenseTemplate[] = [];
  const visited = new Set<UUIDv7>([leaf.id]);
  let cursor: UUIDv7 | null = leaf.parent_id;
  let truncated = false;
  while (cursor !== null) {
    if (chain.length >= MAX_TEMPLATE_DEPTH) {
      truncated = true;
      logger.warn(
        `template inheritance walk hit depth cap; resolution stopped after ${MAX_TEMPLATE_DEPTH} ancestors`,
        { leafId: leaf.id, leafName: leaf.name },
      );
      break;
    }
    if (visited.has(cursor)) {
      logger.warn(`template inheritance chain revisits ${cursor}; halting walk`, {
        leafId: leaf.id,
        leafName: leaf.name,
      });
      break;
    }
    visited.add(cursor);
    const node = await loader(cursor);
    if (!node) break;
    chain.push(node);
    cursor = node.parent_id;
  }

  // Deep-merge with child-wins precedence: walk root -> leaf so children
  // overwrite ancestors. Then overlay the leaf last.
  let entitlements: Record<string, JSONValue> = {};
  let meta: Record<string, JSONValue> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    const ancestor = chain[i] as LicenseTemplate;
    entitlements = deepMergeJson(entitlements, ancestor.entitlements);
    meta = deepMergeJson(meta, ancestor.meta);
  }
  entitlements = deepMergeJson(entitlements, leaf.entitlements);
  meta = deepMergeJson(meta, leaf.meta);

  return {
    id: leaf.id,
    scope_id: leaf.scope_id,
    parent_id: leaf.parent_id,
    name: leaf.name,
    max_usages: leaf.max_usages,
    trial_duration_sec: leaf.trial_duration_sec,
    trial_cooldown_sec: leaf.trial_cooldown_sec,
    grace_duration_sec: leaf.grace_duration_sec,
    force_online_after_sec: leaf.force_online_after_sec,
    entitlements,
    meta,
    inheritedDepth: chain.length,
    truncated,
  };
}

/**
 * Deep-merge two JSON objects with child-wins semantics. Plain-object values
 * recurse; arrays and primitives are replaced wholesale. The output is a
 * new plain object — input maps are never mutated, so the resolver can be
 * called concurrently without races.
 */
export function deepMergeJson(
  base: Readonly<Record<string, JSONValue>>,
  override: Readonly<Record<string, JSONValue>>,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMergeJson(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Readonly<Record<string, JSONValue>> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
