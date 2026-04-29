/**
 * Unit tests for the template-inheritance resolver. Cycle rejection lives in
 * the storage-adapter tests; here we focus on the resolver's read-path
 * behaviour: flat, hierarchical, deep-merge precedence, depth cap, cycle
 * fallback (no throw, just a warning).
 */

import { describe, expect, it } from 'bun:test';

import {
  MAX_TEMPLATE_DEPTH,
  type ResolveLogger,
  resolveTemplate,
  type TemplateLoader,
} from '../../src/templates/resolve.ts';
import type { LicenseTemplate, UUIDv7 } from '../../src/types.ts';

function tmpl(
  id: string,
  parent_id: string | null,
  entitlements: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): LicenseTemplate {
  return {
    id: id as UUIDv7,
    scope_id: null,
    parent_id: (parent_id as UUIDv7 | null) ?? null,
    name: id,
    max_usages: 5,
    trial_duration_sec: 0,
    trial_cooldown_sec: null,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: entitlements as never,
    meta: meta as never,
    created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-01T00:00:00.000000Z',
  };
}

function loaderFor(templates: LicenseTemplate[]): TemplateLoader {
  const byId = new Map(templates.map((t) => [t.id, t]));
  return async (id) => byId.get(id) ?? null;
}

function captureLogger(): { logger: ResolveLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: { warn: (m) => warnings.push(m) },
    warnings,
  };
}

describe('resolveTemplate', () => {
  it('flat template returns its own entitlements + meta unchanged', async () => {
    const a = tmpl('a', null, { tier: 'basic', seats: 5 }, { source: 'a' });
    const result = await resolveTemplate(a, loaderFor([a]));
    expect(result.entitlements).toEqual({ tier: 'basic', seats: 5 });
    expect(result.meta).toEqual({ source: 'a' });
    expect(result.inheritedDepth).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('1-level child overlays its entitlements onto parent (child wins on key conflict)', async () => {
    const a = tmpl('a', null, { tier: 'basic', seats: 5 });
    const b = tmpl('b', 'a', { tier: 'pro' });
    const result = await resolveTemplate(b, loaderFor([a, b]));
    // child wins on `tier`, inherits `seats` from parent.
    expect(result.entitlements).toEqual({ tier: 'pro', seats: 5 });
    expect(result.inheritedDepth).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('3-level chain merges with child-wins precedence per the spec scenario', async () => {
    const a = tmpl('a', null, { tier: 'basic', seats: 5 });
    const b = tmpl('b', 'a', { tier: 'pro' });
    const c = tmpl('c', 'b', { sso: true });
    const result = await resolveTemplate(c, loaderFor([a, b, c]));
    expect(result.entitlements).toEqual({ tier: 'pro', seats: 5, sso: true });
    expect(result.inheritedDepth).toBe(2);
  });

  it('deep-merges nested objects rather than replacing wholesale', async () => {
    const a = tmpl('a', null, { features: { sso: false, audit: true } });
    const b = tmpl('b', 'a', { features: { sso: true } });
    const result = await resolveTemplate(b, loaderFor([a, b]));
    expect(result.entitlements).toEqual({ features: { sso: true, audit: true } });
  });

  it('replaces arrays wholesale (no array merging)', async () => {
    const a = tmpl('a', null, { regions: ['us', 'eu'] });
    const b = tmpl('b', 'a', { regions: ['ap'] });
    const result = await resolveTemplate(b, loaderFor([a, b]));
    expect(result.entitlements).toEqual({ regions: ['ap'] });
  });

  it('caps walk at MAX_TEMPLATE_DEPTH and emits a warning', async () => {
    // 8 ancestors; depth cap is 5.
    const templates: LicenseTemplate[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 8; i++) {
      const id = `n${i}`;
      templates.push(tmpl(id, prev, { level: i }));
      prev = id;
    }
    // leaf has parent_id = 'n7'.
    const leaf = tmpl('leaf', 'n7', { is_leaf: true });
    templates.push(leaf);
    const { logger, warnings } = captureLogger();
    const result = await resolveTemplate(leaf, loaderFor(templates), logger);
    expect(result.truncated).toBe(true);
    expect(result.inheritedDepth).toBe(MAX_TEMPLATE_DEPTH);
    expect(warnings.some((w) => w.includes('depth cap'))).toBe(true);
    // Leaf's own keys still applied; some ancestors merged but not all.
    expect(result.entitlements.is_leaf).toBe(true);
  });

  it('halts gracefully on a corrupted cycle without throwing', async () => {
    // a -> b -> a (cycle); resolver should bail with a warning.
    const a = tmpl('a', 'b', { tag: 'a' });
    const b = tmpl('b', 'a', { tag: 'b' });
    const { logger, warnings } = captureLogger();
    const result = await resolveTemplate(a, loaderFor([a, b]), logger);
    expect(warnings.some((w) => w.includes('revisits'))).toBe(true);
    // Whatever was merged is at least the leaf's own entitlements.
    expect(result.entitlements.tag).toBeDefined();
  });

  it('handles broken parent reference (loader returns null) without throwing', async () => {
    const orphan = tmpl('o', 'missing', { tier: 'orphan' });
    const result = await resolveTemplate(orphan, loaderFor([orphan]));
    // Walk stops; leaf's entitlements still surface.
    expect(result.entitlements).toEqual({ tier: 'orphan' });
    expect(result.inheritedDepth).toBe(0);
  });

  it('does not mutate input objects', async () => {
    const a = tmpl('a', null, { tier: 'basic' });
    const b = tmpl('b', 'a', { tier: 'pro' });
    const aBefore = JSON.stringify(a);
    const bBefore = JSON.stringify(b);
    await resolveTemplate(b, loaderFor([a, b]));
    expect(JSON.stringify(a)).toBe(aBefore);
    expect(JSON.stringify(b)).toBe(bBefore);
  });

  it('passes through non-merged inheritable fields from the leaf', async () => {
    const a = tmpl('a', null, {});
    const b: LicenseTemplate = {
      ...tmpl('b', 'a', {}),
      max_usages: 100,
      trial_duration_sec: 86400,
      trial_cooldown_sec: 3600,
      grace_duration_sec: 7200,
      force_online_after_sec: 43200,
    };
    const result = await resolveTemplate(b, loaderFor([a, b]));
    expect(result.max_usages).toBe(100);
    expect(result.trial_duration_sec).toBe(86400);
    expect(result.trial_cooldown_sec).toBe(3600);
    expect(result.grace_duration_sec).toBe(7200);
    expect(result.force_online_after_sec).toBe(43200);
  });
});
