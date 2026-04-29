/**
 * Cycle detection on template re-parenting (memory adapter).
 *
 * The storage spec requires that any update placing a template's parent
 * chain into a cycle is rejected at write time with `TemplateCycle`. This
 * test exercises the memory adapter; sqlite + postgres tests live alongside
 * their adapter directories.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory/index.ts';
import type { LicenseTemplateInput } from '../../src/storage/types.ts';
import type { UUIDv7 } from '../../src/types.ts';

function freshTemplateInput(name: string, parent_id: UUIDv7 | null = null): LicenseTemplateInput {
  return {
    scope_id: null,
    parent_id,
    name,
    max_usages: 5,
    trial_duration_sec: 0,
    trial_cooldown_sec: null,
    grace_duration_sec: 0,
    force_online_after_sec: null,
    entitlements: {},
    meta: {},
  };
}

describe('memory adapter — template cycle detection', () => {
  it('rejects direct self-cycle on update (parent_id = self.id)', async () => {
    const s = new MemoryStorage();
    const a = await s.createTemplate(freshTemplateInput('a'));
    await expect(s.updateTemplate(a.id, { parent_id: a.id })).rejects.toMatchObject({
      code: 'TemplateCycle',
    });
    // Row unchanged.
    const after = await s.getTemplate(a.id);
    expect(after?.parent_id).toBeNull();
  });

  it('rejects indirect cycle: a → b → c, then update a.parent_id to c', async () => {
    const s = new MemoryStorage();
    const a = await s.createTemplate(freshTemplateInput('a'));
    const b = await s.createTemplate(freshTemplateInput('b', a.id));
    const c = await s.createTemplate(freshTemplateInput('c', b.id));
    await expect(s.updateTemplate(a.id, { parent_id: c.id })).rejects.toMatchObject({
      code: 'TemplateCycle',
    });
    // Existing chain intact.
    const aAfter = await s.getTemplate(a.id);
    const bAfter = await s.getTemplate(b.id);
    const cAfter = await s.getTemplate(c.id);
    expect(aAfter?.parent_id).toBeNull();
    expect(bAfter?.parent_id).toBe(a.id);
    expect(cAfter?.parent_id).toBe(b.id);
  });

  it('allows valid re-parenting that does not introduce a cycle', async () => {
    const s = new MemoryStorage();
    const root1 = await s.createTemplate(freshTemplateInput('root1'));
    const root2 = await s.createTemplate(freshTemplateInput('root2'));
    const child = await s.createTemplate(freshTemplateInput('child', root1.id));
    const moved = await s.updateTemplate(child.id, { parent_id: root2.id });
    expect(moved.parent_id).toBe(root2.id);
  });

  it('allows detaching a child by setting parent_id to null', async () => {
    const s = new MemoryStorage();
    const a = await s.createTemplate(freshTemplateInput('a'));
    const b = await s.createTemplate(freshTemplateInput('b', a.id));
    const detached = await s.updateTemplate(b.id, { parent_id: null });
    expect(detached.parent_id).toBeNull();
  });

  it('rejects createTemplate with a parent_id that does not exist', async () => {
    const s = new MemoryStorage();
    const fakeParent = '01939e6f-0000-7000-8000-000000000099' as UUIDv7;
    await expect(s.createTemplate(freshTemplateInput('a', fakeParent))).rejects.toMatchObject({
      code: 'UniqueConstraintViolation',
    });
  });

  it('listTemplates filters by parent_id (including parent_id: null for roots)', async () => {
    const s = new MemoryStorage();
    const root = await s.createTemplate(freshTemplateInput('root'));
    await s.createTemplate(freshTemplateInput('child1', root.id));
    await s.createTemplate(freshTemplateInput('child2', root.id));

    const roots = await s.listTemplates({ parent_id: null }, { limit: 10 });
    expect(roots.items.length).toBe(1);
    expect(roots.items[0]?.name).toBe('root');

    const children = await s.listTemplates({ parent_id: root.id }, { limit: 10 });
    expect(children.items.length).toBe(2);
    expect(children.items.map((t) => t.name).sort()).toEqual(['child1', 'child2']);
  });
});
