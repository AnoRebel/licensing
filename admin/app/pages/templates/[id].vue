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
  max_usages: v.pipe(v.number(), v.integer(), v.minValue(1, 'At least 1'), v.maxValue(100_000)),
  trial_duration_sec: v.pipe(v.number(), v.integer(), v.minValue(0)),
  grace_duration_sec: v.pipe(v.number(), v.integer(), v.minValue(0)),
  force_online_after_sec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  entitlements: jsonObjectField(),
  meta: jsonObjectField(),
});

interface EditTemplateValues {
  name: string;
  max_usages: number;
  trial_duration_sec: number;
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
    max_usages: 1,
    trial_duration_sec: 0,
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
          max_usages: value.max_usages,
          trial_duration_sec: value.trial_duration_sec,
          grace_duration_sec: value.grace_duration_sec,
          force_online_after_sec: value.force_online_after_sec ?? null,
          entitlements: ent.value,
          meta: met.value,
        },
      });
      toast.success('Template updated');
      await refreshTemplate();
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
    editForm.setFieldValue('max_usages', next.max_usages);
    editForm.setFieldValue('trial_duration_sec', next.trial_duration_sec);
    editForm.setFieldValue('grace_duration_sec', next.grace_duration_sec);
    editForm.setFieldValue('force_online_after_sec', next.force_online_after_sec ?? undefined);
    editForm.setFieldValue('entitlements', stringifyJson(next.entitlements));
    editForm.setFieldValue('meta', stringifyJson(next.meta));
  },
  { immediate: true },
);

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
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                  {{ state.meta.errors.join(', ') }}
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
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                    {{ state.meta.errors.join(', ') }}
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
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                    {{ state.meta.errors.join(', ') }}
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
                    @update:model-value="(v: string | number) => field.handleChange(toNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                    {{ state.meta.errors.join(', ') }}
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
                    @update:model-value="(v: string | number) => field.handleChange(toOptionalNumber(v))"
                    @blur="field.handleBlur"
                  />
                  <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                    {{ state.meta.errors.join(', ') }}
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
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                  {{ state.meta.errors.join(', ') }}
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
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                  {{ state.meta.errors.join(', ') }}
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
  </div>
</template>
