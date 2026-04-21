<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import { templateColumns } from './columns';

type Template = components['schemas']['Template'];

/**
 * Templates index.
 *
 * Templates are lookup defaults — operators reach for them when bulk
 * provisioning licenses. The list is filterable by scope (server-side,
 * via `scope_id`) and by free-text on name (client-side). A "New
 * template" dialog captures the 5 numeric defaults + a scope; the
 * entitlements JSON is edited from the detail page where we can render
 * proper feedback on JSON parse errors.
 */

useHead({ title: 'Templates — Licensing Admin' });

const route = useRoute();
const router = useRouter();

const scopeQuery = computed(() =>
  typeof route.query.scope_id === 'string' ? route.query.scope_id : undefined,
);
const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const listQuery = computed(() => ({
  limit: 50,
  cursor: cursorQuery.value,
  scope_id: scopeQuery.value,
}));

const { data, pending, error, refresh } = await useLicensing('/admin/templates', {
  query: listQuery,
  key: 'admin-templates-list',
  watch: [listQuery],
});

const items = computed<Template[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

// Scopes feed the server-side filter dropdown + create form.
const { data: scopesData } = await useLicensing('/admin/scopes', { query: { limit: 100 } });
const scopes = computed(() => scopesData.value?.data?.items ?? []);

const cursorStack = ref<string[]>([]);

function applyServerFilter(patch: Record<string, string | undefined>) {
  cursorStack.value = [];
  const merged = { ...route.query, ...patch };
  const next = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined && v !== ''),
  );
  router.push({ query: next });
}

function goNext() {
  if (!nextCursor.value) return;
  cursorStack.value = [...cursorStack.value, cursorQuery.value ?? ''];
  router.push({ query: { ...route.query, cursor: nextCursor.value } });
}

function goPrev() {
  const prev = cursorStack.value[cursorStack.value.length - 1];
  cursorStack.value = cursorStack.value.slice(0, -1);
  const query = { ...route.query };
  if (prev) query.cursor = prev;
  else delete query.cursor;
  router.push({ query });
}

const errorMessage = computed(() =>
  error.value ? 'Could not load templates. Check the upstream API.' : null,
);

// --- Create template ----------------------------------------------------
const { $licensing } = useNuxtApp();
const createOpen = ref(false);

// We use a scope + numeric defaults schema. Entitlements are edited on
// the detail page — keeping the create dialog focused.
const CreateSchema = v.object({
  scope_id: v.pipe(v.string(), v.uuid('Must be a scope UUID')),
  name: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.maxLength(128, 'At most 128 characters'),
  ),
  max_usages: v.pipe(
    v.number('Must be a number'),
    v.integer('Must be an integer'),
    v.minValue(1, 'At least 1'),
    v.maxValue(100_000, 'Absurd; pick something reasonable'),
  ),
  trial_duration_sec: v.pipe(
    v.number('Must be a number'),
    v.integer('Must be an integer'),
    v.minValue(0, 'Non-negative'),
  ),
  grace_duration_sec: v.pipe(
    v.number('Must be a number'),
    v.integer('Must be an integer'),
    v.minValue(0, 'Non-negative'),
  ),
  force_online_after_sec: v.optional(
    v.pipe(
      v.number('Must be a number'),
      v.integer('Must be an integer'),
      v.minValue(0, 'Non-negative'),
    ),
  ),
});

interface FetchErrorLike {
  status?: number;
  data?: { error?: { code?: string; message?: string }; message?: string };
  message?: string;
}
function errorToMessage(err: unknown, fallback: string): string {
  const e = err as FetchErrorLike;
  const msg = e?.data?.error?.message ?? e?.data?.message ?? e?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

// Default the create form's scope to the currently-filtered scope (if
// any) so operators can "filter → new" without reselecting.
interface CreateTemplateValues {
  scope_id: string;
  name: string;
  max_usages: number;
  trial_duration_sec: number;
  grace_duration_sec: number;
  force_online_after_sec: number | undefined;
}

function validateCreateTemplate(value: CreateTemplateValues) {
  const res = v.safeParse(CreateSchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const createForm = useForm({
  defaultValues: {
    scope_id: '',
    name: '',
    max_usages: 1,
    trial_duration_sec: 0,
    grace_duration_sec: 0,
    force_online_after_sec: undefined as number | undefined,
  },
  validators: {
    onChange: ({ value }) => validateCreateTemplate(value),
    onSubmit: ({ value }) => validateCreateTemplate(value),
  },
  onSubmit: async ({ value }) => {
    try {
      const res = await $licensing('/admin/templates', {
        method: 'POST',
        body: {
          scope_id: value.scope_id,
          name: value.name.trim(),
          max_usages: value.max_usages,
          trial_duration_sec: value.trial_duration_sec,
          grace_duration_sec: value.grace_duration_sec,
          force_online_after_sec: value.force_online_after_sec ?? null,
        },
      });
      toast.success('Template created');
      createOpen.value = false;
      createForm.reset();
      const created = res?.data;
      if (created?.id) router.push(`/templates/${created.id}`);
      else await refresh();
    } catch (e) {
      toast.error(errorToMessage(e, 'Could not create template'));
    }
  },
});

function openCreate() {
  // Pre-fill scope from current filter for fast iteration.
  if (scopeQuery.value) createForm.setFieldValue('scope_id', scopeQuery.value);
  createOpen.value = true;
}

// Cast numeric <input> values back to number — `<Input type="number">`
// emits string|number from shadcn-vue's Input. We narrow to number so
// the form/schema stays sharply typed.
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
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          resource
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Templates</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
        <Button size="sm" @click="openCreate">New template</Button>
      </div>
    </header>

    <section
      aria-label="Server filters"
      class="grid grid-cols-1 gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2"
    >
      <div class="space-y-1.5">
        <Label for="server-scope" class="text-xs font-normal text-muted-foreground">
          Scope
        </Label>
        <select
          id="server-scope"
          :value="scopeQuery ?? ''"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="(e) => applyServerFilter({ scope_id: (e.target as HTMLSelectElement).value || undefined, cursor: undefined })"
        >
          <option value="">any scope</option>
          <option v-for="s in scopes" :key="s.id" :value="s.id">
            {{ s.slug }}
          </option>
        </select>
      </div>
    </section>

    <p v-if="errorMessage" role="alert" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>

    <DataTable
      v-else
      :columns="templateColumns"
      :data="items"
      :loading="pending"
      search-column="name"
      search-placeholder="Filter by name…"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No templates match these filters."
      @row-click="(row) => router.push(`/templates/${(row as Template).id}`)"
      @prev="goPrev"
      @next="goNext"
    />

    <!-- Create dialog -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Templates capture default policy values (seat count, trial and grace windows)
            that copy onto licenses at creation time. Per-license overrides take
            precedence — the template only supplies the baseline.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent.stop="createForm.handleSubmit()">
          <createForm.Field name="scope_id">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Scope
                </Label>
                <select
                  :id="field.name"
                  :value="state.value"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  required
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @change="(e) => field.handleChange((e.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>select a scope</option>
                  <option v-for="s in scopes" :key="s.id" :value="s.id">
                    {{ s.slug }}
                  </option>
                </select>
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
          </createForm.Field>

          <createForm.Field name="name">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Name
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  placeholder="Pro Yearly"
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
          </createForm.Field>

          <div class="grid grid-cols-2 gap-4">
            <createForm.Field name="max_usages">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    max_usages
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    inputmode="numeric"
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
            </createForm.Field>

            <createForm.Field name="trial_duration_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    trial_duration_sec
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    inputmode="numeric"
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
            </createForm.Field>

            <createForm.Field name="grace_duration_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    grace_duration_sec
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    inputmode="numeric"
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
            </createForm.Field>

            <createForm.Field name="force_online_after_sec">
              <template #default="{ field, state }">
                <div class="space-y-1.5">
                  <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                    force_online_after_sec
                    <span class="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    :id="field.name"
                    type="number"
                    inputmode="numeric"
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
            </createForm.Field>
          </div>

          <DialogFooter>
            <createForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="isSubmitting"
                  @click="createOpen = false"
                >
                  Cancel
                </Button>
                <Button type="submit" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Working…' : 'Create template' }}
                </Button>
              </template>
            </createForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
