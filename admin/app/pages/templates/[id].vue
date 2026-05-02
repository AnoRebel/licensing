<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';

type Template = components['schemas']['Template'];

/**
 * Template detail — edit + delete.
 *
 * Entitlements and meta are free-form JSON objects. We give operators a
 * Textarea with live JSON parse feedback so a typo doesn't round-trip to
 * the server just to be rejected. Invalid JSON disables the save button.
 *
 * Delete is destructive (409 if any license still references it), so
 * it's gated by ConfirmDestructive on the template's name.
 */

useHead({ title: 'Template — Licensing Admin' });

const route = useRoute();
const router = useRouter();
const templateId = computed(() => route.params.id as string);

const { $licensing } = useNuxtApp();

const {
  data: templateData,
  pending: templatePending,
  error: templateError,
  refresh: refreshTemplate,
} = await useLicensing('/admin/templates/{id}', {
  path: { id: templateId.value },
  key: `admin-template-${templateId.value}`,
});

const template = computed<Template | undefined>(() => templateData.value?.data);

// Scopes used for the (read-only) scope display + potential future moves.
const { data: scopesData } = await useLicensing('/admin/scopes', { query: { limit: 100 } });
const scopes = computed(() => scopesData.value?.data?.items ?? []);
const scopeSlug = computed(() => {
  const id = template.value?.scope_id;
  if (!id) return '—';
  return scopes.value.find((s) => s.id === id)?.slug ?? id;
});

// All templates (capped at 200) feed the parent_id combobox + the
// hierarchy preview. Server-side cycle detection is authoritative; we
// still hide the current template + its descendants from the picker so
// the obvious mistakes don't even appear as options.
const { data: allTemplatesData, refresh: refreshAllTemplates } = await useLicensing(
  '/admin/templates',
  {
    query: { limit: 200 },
    key: `admin-templates-all-for-parent-picker-${templateId.value}`,
  },
);
const allTemplates = computed<Template[]>(() => allTemplatesData.value?.data?.items ?? []);

// Walk the parent chain from `id` (inclusive) and return the set of ids
// reachable via parent_id pointers — for the picker exclusion below.
function descendantsOf(id: string): ReadonlySet<string> {
  const seen = new Set<string>([id]);
  // Reverse adjacency: parent_id -> [children]. One pass over the list.
  const childMap = new Map<string, string[]>();
  for (const t of allTemplates.value) {
    if (t.parent_id) {
      const arr = childMap.get(t.parent_id) ?? [];
      arr.push(t.id);
      childMap.set(t.parent_id, arr);
    }
  }
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of childMap.get(next) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

const parentForbidden = computed<ReadonlySet<string>>(() =>
  template.value ? descendantsOf(template.value.id) : new Set(),
);
const parentOptions = computed(() =>
  allTemplates.value
    .filter((t) => !parentForbidden.value.has(t.id))
    .map((t) => ({ id: t.id, label: t.name })),
);

// Walk parent_id chain rootward from the current template — used by the
// hierarchy preview breadcrumb. Stops at the first nil parent or after
// the safety bound (matches the storage-level cycle bound).
function ancestorChain(t: Template | undefined): readonly Template[] {
  if (!t) return [];
  const chain: Template[] = [];
  let cursor: Template | undefined = t;
  const guard = new Set<string>();
  while (cursor && cursor.parent_id && !guard.has(cursor.parent_id)) {
    guard.add(cursor.parent_id);
    const next = allTemplates.value.find((x) => x.id === cursor!.parent_id);
    if (!next) break;
    chain.push(next);
    cursor = next;
  }
  return chain;
}

const ancestors = computed(() => ancestorChain(template.value));
const children = computed<readonly Template[]>(() =>
  template.value
    ? allTemplates.value.filter((t) => t.parent_id === template.value!.id)
    : [],
);

// --- JSON helpers -------------------------------------------------------
function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function tryParseJson(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- Edit form ----------------------------------------------------------
//
// Both JSON editors live inside the form (as string fields) so their
// parse errors feed `canSubmit` directly — no external gating ref.
// A `v.check` step on each string field runs `tryParseJson` so the
// valibot error lives in field state.
function jsonObjectField() {
  return v.pipe(
    v.string(),
    v.check((s) => {
      const r = tryParseJson(s);
      return r.ok;
    }, 'Must be a JSON object'),
  );
}

const EditSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.maxLength(128, 'At most 128 characters'),
  ),
  parent_id: v.optional(v.pipe(v.string(), v.uuid('Must be a template UUID'))),
  max_usages: v.pipe(v.number(), v.integer(), v.minValue(1, 'At least 1'), v.maxValue(100_000)),
  trial_duration_sec: v.pipe(v.number(), v.integer(), v.minValue(0)),
  trial_cooldown_sec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  grace_duration_sec: v.pipe(v.number(), v.integer(), v.minValue(0)),
  force_online_after_sec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  entitlements: jsonObjectField(),
  meta: jsonObjectField(),
});

interface EditTemplateValues {
  name: string;
  parent_id: string | undefined;
  max_usages: number;
  trial_duration_sec: number;
  trial_cooldown_sec: number | undefined;
  grace_duration_sec: number;
  force_online_after_sec: number | undefined;
  entitlements: string;
  meta: string;
}

function validateEditTemplate(value: EditTemplateValues) {
  const res = v.safeParse(EditSchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const editForm = useForm({
  defaultValues: {
    name: '',
    parent_id: undefined as string | undefined,
    max_usages: 1,
    trial_duration_sec: 0,
    trial_cooldown_sec: undefined as number | undefined,
    grace_duration_sec: 0,
    force_online_after_sec: undefined as number | undefined,
    entitlements: '{}',
    meta: '{}',
  },
  validators: {
    onChange: ({ value }) => validateEditTemplate(value),
    onSubmit: ({ value }) => validateEditTemplate(value),
  },
  onSubmit: async ({ value }) => {
    const ent = tryParseJson(value.entitlements);
    const met = tryParseJson(value.meta);
    if (!ent.ok || !met.ok) return; // Should be unreachable given canSubmit.
    try {
      await $licensing('/admin/templates/{id}', {
        method: 'PATCH',
        path: { id: templateId.value },
        body: {
          name: value.name.trim(),
          parent_id: value.parent_id ?? null,
          max_usages: value.max_usages,
          trial_duration_sec: value.trial_duration_sec,
          trial_cooldown_sec: value.trial_cooldown_sec ?? null,
          grace_duration_sec: value.grace_duration_sec,
          force_online_after_sec: value.force_online_after_sec ?? null,
          entitlements: ent.value,
          meta: met.value,
        },
      });
      toast.success('Template updated');
      await refreshTemplate();
      await refreshAllTemplates();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not update template'));
    }
  },
});

// Sync form when the template loads/refetches, but don't clobber
// in-flight edits. `state.isSubmitting` is the reactive source of truth.
watch(
  template,
  (next) => {
    if (!next || editForm.state.isSubmitting) return;
    editForm.setFieldValue('name', next.name);
    editForm.setFieldValue('parent_id', next.parent_id ?? undefined);
    editForm.setFieldValue('max_usages', next.max_usages);
    editForm.setFieldValue('trial_duration_sec', next.trial_duration_sec);
    editForm.setFieldValue('trial_cooldown_sec', next.trial_cooldown_sec ?? undefined);
    editForm.setFieldValue('grace_duration_sec', next.grace_duration_sec);
    editForm.setFieldValue('force_online_after_sec', next.force_online_after_sec ?? undefined);
    editForm.setFieldValue('entitlements', stringifyJson(next.entitlements));
    editForm.setFieldValue('meta', stringifyJson(next.meta));
  },
  { immediate: true },
);

// --- Parent picker state ------------------------------------------------
const parentPickerOpen = ref(false);
const parentPickerSearch = ref('');
function parentLabelFor(id: string | undefined): string {
  if (!id) return 'No parent (root template)';
  return allTemplates.value.find((t) => t.id === id)?.name ?? id;
}

// --- Issue-from-template flow -------------------------------------------
//
// Operators reach for "issue from template" once the template's defaults
// are dialled in. We gather the minimum CreateLicenseRequest fields here
// (licensable_type, licensable_id, optional license_key) and POST
// /admin/licenses with template_id pre-filled. On success we navigate
// straight to the new license's detail page so the operator can attach
// usages / make further policy tweaks without going back through the
// list.
const issueOpen = ref(false);
const IssueSchema = v.object({
  licensable_type: v.pipe(v.string(), v.trim(), v.nonEmpty('Required'), v.maxLength(128)),
  licensable_id: v.pipe(v.string(), v.trim(), v.nonEmpty('Required'), v.maxLength(128)),
  license_key: v.optional(v.pipe(v.string(), v.trim())),
});
interface IssueValues {
  licensable_type: string;
  licensable_id: string;
  license_key: string | undefined;
}
function validateIssue(value: IssueValues) {
  const r = v.safeParse(IssueSchema, value);
  return r.success ? undefined : 'Fix the highlighted fields';
}
const issueForm = useForm({
  defaultValues: {
    licensable_type: '',
    licensable_id: '',
    license_key: undefined as string | undefined,
  },
  validators: {
    onChange: ({ value }) => validateIssue(value),
    onSubmit: ({ value }) => validateIssue(value),
  },
  onSubmit: async ({ value }) => {
    if (!template.value) return;
    try {
      const res = await $licensing('/admin/licenses', {
        method: 'POST',
        body: {
          scope_id: template.value.scope_id ?? null,
          template_id: template.value.id,
          licensable_type: value.licensable_type.trim(),
          licensable_id: value.licensable_id.trim(),
          license_key: value.license_key?.trim() || null,
          // max_usages is required by CreateLicenseRequest; copy the
          // template's own default so the issued license matches the
          // template's seat policy unless the operator edits later.
          max_usages: template.value.max_usages,
        },
      });
      const created = res?.data;
      toast.success('License issued');
      issueOpen.value = false;
      issueForm.reset();
      if (created?.id) router.push(`/licenses/${created.id}`);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not issue license'));
    }
  },
});

// --- Delete -------------------------------------------------------------
const confirmOpen = ref(false);
const deletePending = ref(false);

function openConfirmDelete() {
  confirmOpen.value = true;
}

async function onConfirmDelete() {
  if (!template.value) return;
  deletePending.value = true;
  try {
    await $licensing('/admin/templates/{id}', {
      method: 'DELETE',
      path: { id: templateId.value },
    });
    toast.success('Template deleted');
    confirmOpen.value = false;
    router.push('/templates');
  } catch (e) {
    toast.error(errorMessage(e, 'Could not delete template'));
  } finally {
    deletePending.value = false;
  }
}

// --- Helpers ------------------------------------------------------------
interface FetchErrorLike {
  status?: number;
  data?: { error?: { code?: string; message?: string }; message?: string };
  message?: string;
}
function errorMessage(err: unknown, fallback: string): string {
  const e = err as FetchErrorLike;
  const msg = e?.data?.error?.message ?? e?.data?.message ?? e?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}
function toOptionalNumber(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = toNumber(v);
  return Number.isFinite(n) ? n : undefined;
}

const templateErrorMessage = computed(() =>
  templateError.value ? 'Could not load template.' : null,
);
</script>

<template>
  <div class="space-y-8">
    <NuxtLink
      to="/templates"
      class="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
    >
      ← back to templates
    </NuxtLink>

    <p v-if="templateErrorMessage" role="alert" class="text-sm text-destructive">
      {{ templateErrorMessage }}
    </p>

    <section v-else-if="templatePending && !template" aria-busy="true" class="space-y-4">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-64 w-full" />
    </section>

    <template v-else-if="template">
      <header class="space-y-4">
        <div class="space-y-2">
          <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            template
          </p>
          <h1 class="text-2xl font-semibold tracking-tight">{{ template.name }}</h1>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
            <span>scope:
              <NuxtLink
                v-if="template.scope_id"
                :to="`/scopes/${template.scope_id}`"
                class="underline-offset-2 hover:underline"
              >
                {{ scopeSlug }}
              </NuxtLink>
              <span v-else>—</span>
            </span>
            <span>id: <span class="break-all">{{ template.id }}</span></span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" @click="issueOpen = true">Issue license…</Button>
          <Button
            variant="outline"
            size="sm"
            class="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="deletePending"
            @click="openConfirmDelete"
          >
            Delete…
          </Button>
          <Button variant="ghost" size="sm" :disabled="templatePending" @click="refreshTemplate()">
            Refresh
          </Button>
        </div>
      </header>

      <section
        v-if="ancestors.length > 0 || children.length > 0"
        aria-label="Template hierarchy"
        class="rounded-md border border-border bg-card p-4 space-y-3"
      >
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          hierarchy
        </p>
        <div v-if="ancestors.length > 0" class="space-y-1">
          <p class="text-xs font-normal text-muted-foreground">Ancestors (inheritance chain)</p>
          <nav aria-label="Parent chain" class="flex flex-wrap items-center gap-1 text-sm">
            <template v-for="(a, idx) in ancestors.slice().reverse()" :key="a.id">
              <NuxtLink
                :to="`/templates/${a.id}`"
                class="rounded-md px-1.5 py-0.5 font-mono text-xs underline-offset-2 hover:bg-muted hover:underline"
              >
                {{ a.name }}
              </NuxtLink>
              <span v-if="idx < ancestors.length - 1" aria-hidden="true" class="text-muted-foreground">›</span>
            </template>
            <span aria-hidden="true" class="text-muted-foreground">›</span>
            <span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{{ template.name }}</span>
          </nav>
        </div>
        <div v-if="children.length > 0" class="space-y-1">
          <p class="text-xs font-normal text-muted-foreground">
            Direct children ({{ children.length }})
          </p>
          <ul class="grid gap-1 sm:grid-cols-2">
            <li v-for="c in children" :key="c.id">
              <NuxtLink
                :to="`/templates/${c.id}`"
                class="block rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              >
                <span class="font-mono">{{ c.name }}</span>
                <span class="ml-2 text-muted-foreground">{{ c.id.slice(0, 8) }}</span>
              </NuxtLink>
            </li>
          </ul>
        </div>
      </section>

      <section class="rounded-md border border-border bg-card p-4" aria-label="Template metadata">
        <form class="space-y-4" @submit.prevent.stop="editForm.handleSubmit()">
          <editForm.Field name="name">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Name
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  required
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </editForm.Field>

          <editForm.Field name="parent_id">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Parent template
                  <span class="text-muted-foreground">(optional)</span>
                </Label>
                <Popover v-model:open="parentPickerOpen">
                  <PopoverTrigger as-child>
                    <Button
                      :id="field.name"
                      type="button"
                      variant="outline"
                      role="combobox"
                      :aria-expanded="parentPickerOpen"
                      class="w-full justify-between font-normal"
                    >
                      <span :class="{ 'text-muted-foreground': !state.value }">
                        {{ parentLabelFor(state.value) }}
                      </span>
                      <span aria-hidden="true" class="ml-2 text-muted-foreground">⌄</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent class="w-[--reka-popover-trigger-width] p-0" align="start">
                    <Command v-model:search-term="parentPickerSearch">
                      <CommandInput placeholder="Search templates…" />
                      <CommandList>
                        <CommandEmpty>No templates match.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value=""
                            @select="() => { field.handleChange(undefined); parentPickerOpen = false; parentPickerSearch = ''; }"
                          >
                            <span class="font-mono text-xs">— none (root) —</span>
                          </CommandItem>
                          <CommandItem
                            v-for="opt in parentOptions"
                            :key="opt.id"
                            :value="opt.label"
                            @select="() => { field.handleChange(opt.id); parentPickerOpen = false; parentPickerSearch = ''; }"
                          >
                            <span class="truncate">{{ opt.label }}</span>
                            <span class="ml-auto font-mono text-[10px] text-muted-foreground">{{ opt.id.slice(0, 8) }}</span>
                          </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p class="text-xs text-muted-foreground">
                  Self + descendants are hidden — server still rejects cycles with 409.
                </p>
              </div>
            </template>
          </editForm.Field>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <editForm.Field name="max_usages">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    max_usages
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    min="1"
                    :model-value="state.value"
                    class="font-mono"
                    required
                    :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                    :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p
                    v-if="state.meta.isTouched && !state.meta.isValid"
                    :id="`${field.name}-error`"
                    class="text-xs text-destructive"
                    role="alert"
                  >
                    {{ fieldErrors(state.meta.errors) }}
                  </p>
                </div>
              </template>
            </editForm.Field>

            <editForm.Field name="trial_duration_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    trial_duration_sec
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    min="0"
                    :model-value="state.value"
                    class="font-mono"
                    :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                    :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p
                    v-if="state.meta.isTouched && !state.meta.isValid"
                    :id="`${field.name}-error`"
                    class="text-xs text-destructive"
                    role="alert"
                  >
                    {{ fieldErrors(state.meta.errors) }}
                  </p>
                </div>
              </template>
            </editForm.Field>

            <editForm.Field name="trial_cooldown_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    trial_cooldown_sec
                    <span class="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    min="0"
                    :model-value="state.value ?? ''"
                    class="font-mono"
                    placeholder="—"
                    :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                    :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                    @update:model-value="(v: string | number) => field.handleChange(toOptionalNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p
                    v-if="state.meta.isTouched && !state.meta.isValid"
                    :id="`${field.name}-error`"
                    class="text-xs text-destructive"
                    role="alert"
                  >
                    {{ fieldErrors(state.meta.errors) }}
                  </p>
                </div>
              </template>
            </editForm.Field>

            <editForm.Field name="grace_duration_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    grace_duration_sec
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    min="0"
                    :model-value="state.value"
                    class="font-mono"
                    :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                    :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p
                    v-if="state.meta.isTouched && !state.meta.isValid"
                    :id="`${field.name}-error`"
                    class="text-xs text-destructive"
                    role="alert"
                  >
                    {{ fieldErrors(state.meta.errors) }}
                  </p>
                </div>
              </template>
            </editForm.Field>

            <editForm.Field name="force_online_after_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    force_online_after_sec
                    <span class="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    min="0"
                    :model-value="state.value ?? ''"
                    class="font-mono"
                    placeholder="—"
                    :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                    :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                    @update:model-value="(v: string | number) => field.handleChange(toOptionalNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p
                    v-if="state.meta.isTouched && !state.meta.isValid"
                    :id="`${field.name}-error`"
                    class="text-xs text-destructive"
                    role="alert"
                  >
                    {{ fieldErrors(state.meta.errors) }}
                  </p>
                </div>
              </template>
            </editForm.Field>
          </div>

          <editForm.Field name="entitlements">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Entitlements
                  <span class="text-muted-foreground">(JSON object)</span>
                </Label>
                <Textarea
                  :id="field.name"
                  :model-value="state.value"
                  rows="6"
                  class="font-mono text-xs"
                  spellcheck="false"
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </editForm.Field>

          <editForm.Field name="meta">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Meta
                  <span class="text-muted-foreground">(JSON object)</span>
                </Label>
                <Textarea
                  :id="field.name"
                  :model-value="state.value"
                  rows="4"
                  class="font-mono text-xs"
                  spellcheck="false"
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </editForm.Field>

          <div class="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2">
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">created</p>
              <time :datetime="template.created_at" :title="formatAbsolute(template.created_at)">
                {{ formatRelative(template.created_at) }}
              </time>
            </div>
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">updated</p>
              <time :datetime="template.updated_at" :title="formatAbsolute(template.updated_at)">
                {{ formatRelative(template.updated_at) }}
              </time>
            </div>
          </div>

          <div class="flex justify-end">
            <editForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button type="submit" size="sm" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Saving…' : 'Save changes' }}
                </Button>
              </template>
            </editForm.Subscribe>
          </div>
        </form>
      </section>
    </template>

    <ConfirmDestructive
      v-if="template"
      v-model:open="confirmOpen"
      title="Delete template"
      description="Hard-deletes the template. Existing licenses that were created from it are unaffected, but the API rejects the delete with 409 if any still reference this template — reassign those first."
      :confirm-phrase="template.name"
      action-label="Delete template"
      :pending="deletePending"
      @confirm="onConfirmDelete"
    />

    <!-- Issue from template dialog -->
    <Dialog v-if="template" v-model:open="issueOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue license from template</DialogTitle>
          <DialogDescription>
            Creates a license under <span class="font-mono">{{ template.name }}</span>. The
            template's defaults (max_usages, trial / grace windows, entitlements) copy onto the
            new license at creation time.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent.stop="issueForm.handleSubmit()">
          <issueForm.Field name="licensable_type">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  licensable_type
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  placeholder="User"
                  required
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </issueForm.Field>

          <issueForm.Field name="licensable_id">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  licensable_id
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  placeholder="user-123"
                  required
                  class="font-mono"
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </issueForm.Field>

          <issueForm.Field name="license_key">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  license_key
                  <span class="text-muted-foreground">(optional — server generates if blank)</span>
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value ?? ''"
                  placeholder="LIC-XXXX-XXXX-XXXX"
                  class="font-mono"
                  @update:model-value="(v: string | number) => field.handleChange(String(v) || undefined)"
                  @blur="field.handleBlur"
                />
              </div>
            </template>
          </issueForm.Field>

          <DialogFooter>
            <issueForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="isSubmitting"
                  @click="issueOpen = false"
                >
                  Cancel
                </Button>
                <Button type="submit" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Issuing…' : 'Issue license' }}
                </Button>
              </template>
            </issueForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
