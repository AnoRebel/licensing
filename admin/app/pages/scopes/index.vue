<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import { scopeColumns } from './columns';

type Scope = components['schemas']['Scope'];

/**
 * Scopes index — simple cursor list with inline create.
 *
 * Scopes are low-cardinality (a handful per org in practice) so no server
 * filters beyond cursor pagination. The DataTable's client-side
 * free-text filter on `slug` is plenty for narrowing the visible page.
 *
 * Create dialog is inline rather than a separate page because the form
 * is small (3 fields, `slug` + `name` + optional meta) and we want zero
 * navigation churn when provisioning scopes in bulk during setup.
 */

useHead({ title: 'Scopes — Licensing Admin' });

const route = useRoute();
const router = useRouter();

const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const listQuery = computed(() => ({ limit: 50, cursor: cursorQuery.value }));

const { data, pending, error, refresh } = await useLicensing('/admin/scopes', {
  query: listQuery,
  key: 'admin-scopes-list',
  watch: [listQuery],
});

const items = computed<Scope[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

const cursorStack = ref<string[]>([]);

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
  error.value ? 'Could not load scopes. Check the upstream API and try again.' : null,
);

// --- Create scope -------------------------------------------------------
//
// `slug` is globally unique and case-sensitive; the upstream enforces
// `^[a-z0-9][a-z0-9-]*$`. We validate the same regex client-side so
// typos are caught before the round-trip. A 409 still lands in the
// error toast as fallback.
const { $licensing } = useNuxtApp();
const createOpen = ref(false);

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const CreateSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.regex(
      SLUG_RE,
      'Lowercase letters, digits, and hyphens only; must start with a letter or digit',
    ),
    v.maxLength(64, 'At most 64 characters'),
  ),
  name: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.maxLength(128, 'At most 128 characters'),
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

function validateCreateScope(value: { slug: string; name: string }) {
  const res = v.safeParse(CreateSchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const createForm = useForm({
  defaultValues: { slug: '', name: '' },
  validators: {
    onChange: ({ value }) => validateCreateScope(value),
    onSubmit: ({ value }) => validateCreateScope(value),
  },
  onSubmit: async ({ value }) => {
    try {
      const res = await $licensing('/admin/scopes', {
        method: 'POST',
        body: { slug: value.slug.trim(), name: value.name.trim() },
      });
      toast.success('Scope created');
      createOpen.value = false;
      createForm.reset();
      const created = res?.data;
      if (created?.id) router.push(`/scopes/${created.id}`);
      else await refresh();
    } catch (e) {
      toast.error(errorToMessage(e, 'Could not create scope'));
    }
  },
});
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          resource
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Scopes</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
        <Button size="sm" @click="createOpen = true">New scope</Button>
      </div>
    </header>

    <p v-if="errorMessage" role="alert" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>

    <DataTable
      v-else
      :columns="scopeColumns"
      :data="items"
      :loading="pending"
      search-column="slug"
      search-placeholder="Filter by slug…"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No scopes yet. Create one to start provisioning licenses."
      @row-click="(row) => router.push(`/scopes/${(row as Scope).id}`)"
      @prev="goPrev"
      @next="goNext"
    />

    <!-- Create dialog -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New scope</DialogTitle>
          <DialogDescription>
            Scopes partition licenses, templates, and signing keys. The <code>slug</code> is
            immutable once created — pick something stable and short.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent.stop="createForm.handleSubmit()">
          <createForm.Field name="slug">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Slug
                  <span class="font-mono text-muted-foreground">(immutable)</span>
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  class="font-mono"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="acme-prod"
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

          <createForm.Field name="name">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Name
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  placeholder="Acme Production"
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
                  {{ isSubmitting ? 'Working…' : 'Create scope' }}
                </Button>
              </template>
            </createForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
