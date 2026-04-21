<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';
import type { FilterFacet } from '~/components/DataTable/types';
import { keyColumns, type KeyTableMeta } from './columns';

type Key = components['schemas']['Key'];
type KeyState = components['schemas']['KeyState'];
type KeyAlg = components['schemas']['KeyAlg'];

/**
 * Global keys index — the cross-scope view of signing keys.
 *
 * Filters:
 *   - Server-side: `scope_id` (dropdown of scopes), `state` (active|retiring).
 *     URL-query-backed.
 *   - Client-side: free-text on `kid`, faceted state filter (on current page).
 *
 * Actions:
 *   - New key: launches the dialog from scope-detail (here without a
 *     pre-selected scope — operator picks from the dropdown).
 *   - Rotate: per-row, only on active keys, same ConfirmDestructive as
 *     scope-detail. Rotation-result banner appears above the table.
 */

useHead({ title: 'Keys — Licensing Admin' });

const route = useRoute();
const router = useRouter();

const scopeQuery = computed(() =>
  typeof route.query.scope_id === 'string' ? route.query.scope_id : undefined,
);
const stateQuery = computed(() =>
  typeof route.query.state === 'string' ? (route.query.state as KeyState) : undefined,
);
const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const listQuery = computed(() => ({
  limit: 50,
  cursor: cursorQuery.value,
  scope_id: scopeQuery.value ?? undefined,
  state: stateQuery.value,
}));

const { data, pending, error, refresh } = await useLicensing('/admin/keys', {
  query: listQuery,
  key: 'admin-keys-list',
  watch: [listQuery],
});

const items = computed<Key[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

// Scopes feed both the filter dropdown and the id→slug resolver.
const { data: scopesData } = await useLicensing('/admin/scopes', { query: { limit: 100 } });
const scopes = computed(() => scopesData.value?.data?.items ?? []);
const scopeSlugById = computed(() => {
  const map = new Map<string, string>();
  for (const s of scopes.value) map.set(s.id, s.slug);
  return map;
});

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

function clearAllFilters() {
  cursorStack.value = [];
  router.push({ query: {} });
}

const hasActiveServerFilters = computed(() => Boolean(scopeQuery.value || stateQuery.value));

// --- Client facets ------------------------------------------------------
const STATES: KeyState[] = ['active', 'retiring'];
const facets: FilterFacet[] = [
  {
    columnId: 'state',
    title: 'State (on page)',
    options: STATES.map((s) => ({ label: s, value: s })),
  },
];

// --- Rotate action ------------------------------------------------------
const { $licensing } = useNuxtApp();
const confirmOpen = ref(false);
const actionPending = ref(false);
const pendingKey = ref<Key | null>(null);
const lastRotation = ref<{ retiring: Key; active: Key } | null>(null);

function openConfirmRotate(key: Key) {
  pendingKey.value = key;
  confirmOpen.value = true;
}

async function onConfirmRotate() {
  if (!pendingKey.value) return;
  actionPending.value = true;
  try {
    const res = await $licensing('/admin/keys/{id}/rotate', {
      method: 'POST',
      path: { id: pendingKey.value.id },
    });
    const pair = res?.data;
    if (pair) lastRotation.value = pair;
    toast.success('Key rotated');
    confirmOpen.value = false;
    pendingKey.value = null;
    await refresh();
  } catch (e) {
    toast.error(errorMessage(e, 'Could not rotate key'));
  } finally {
    actionPending.value = false;
  }
}

const tableMeta = computed<KeyTableMeta>(() => ({
  onRotate: (key: Key) => openConfirmRotate(key),
  scopeSlugFor: (id: string) => scopeSlugById.value.get(id),
}));

// --- Create key dialog --------------------------------------------------
const createOpen = ref(false);

const KeyAlgValues: KeyAlg[] = ['ed25519', 'rs256-pss', 'hs256'];
const KidRe = /^[a-z0-9][a-z0-9._-]*$/i;

const CreateKeySchema = v.object({
  scope_id: v.pipe(v.string(), v.uuid('Must be a scope UUID')),
  kid: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.regex(KidRe, 'Letters, digits, dot, hyphen, underscore; must start with alnum'),
    v.maxLength(64, 'At most 64 characters'),
  ),
  alg: v.picklist(['ed25519', 'rs256-pss', 'hs256']),
  role: v.picklist(['signing', 'root']),
});

function validateCreateKey(value: {
  scope_id: string;
  kid: string;
  alg: KeyAlg;
  role: 'signing' | 'root';
}) {
  const res = v.safeParse(CreateKeySchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const createForm = useForm({
  defaultValues: {
    scope_id: '',
    kid: '',
    alg: 'ed25519' as KeyAlg,
    role: 'signing' as 'signing' | 'root',
  },
  validators: {
    onChange: ({ value }) => validateCreateKey(value),
    onSubmit: ({ value }) => validateCreateKey(value),
  },
  onSubmit: async ({ value }) => {
    try {
      await $licensing('/admin/keys', {
        method: 'POST',
        body: {
          scope_id: value.scope_id,
          kid: value.kid.trim(),
          alg: value.alg,
          role: value.role,
        },
      });
      toast.success('Signing key created');
      createOpen.value = false;
      createForm.reset();
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not create key'));
    }
  },
});

function openCreate() {
  if (scopeQuery.value) createForm.setFieldValue('scope_id', scopeQuery.value);
  createOpen.value = true;
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

const errorText = computed(() =>
  error.value ? 'Could not load keys. Check the upstream API.' : null,
);
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          resource
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Signing keys</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
        <Button size="sm" @click="openCreate">New key</Button>
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

      <div class="space-y-1.5">
        <Label for="server-state" class="text-xs font-normal text-muted-foreground">
          State
        </Label>
        <select
          id="server-state"
          :value="stateQuery ?? ''"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="(e) => applyServerFilter({ state: (e.target as HTMLSelectElement).value || undefined, cursor: undefined })"
        >
          <option value="">any state</option>
          <option v-for="s in STATES" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>

      <div
        v-if="hasActiveServerFilters"
        class="sm:col-span-2 flex items-center justify-end"
      >
        <Button variant="ghost" size="sm" @click="clearAllFilters">
          Clear server filters
        </Button>
      </div>
    </section>

    <!--
      B23: the live-region (role=status) wraps ONLY the announceable text
      — not the Dismiss button. If the button lives inside role=status,
      its label gets re-announced every time the region re-renders, and
      hitting "Dismiss" can itself trigger a spurious SR announcement.
      The visual container stays one section; the a11y contract splits.
    -->
    <section
      v-if="lastRotation"
      class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-xs"
    >
      <div role="status">
        <p class="font-mono uppercase tracking-wide text-amber-600 dark:text-amber-400">
          rotation complete
        </p>
        <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p class="text-muted-foreground">retiring kid</p>
            <code class="font-mono">{{ lastRotation.retiring.kid }}</code>
          </div>
          <div>
            <p class="text-muted-foreground">new active kid</p>
            <code class="font-mono">{{ lastRotation.active.kid }}</code>
          </div>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="lastRotation = null">
          Dismiss
        </Button>
      </div>
    </section>

    <p v-if="errorText" role="alert" class="text-sm text-destructive">
      {{ errorText }}
    </p>

    <DataTable
      v-else
      :columns="keyColumns"
      :data="items"
      :loading="pending"
      search-column="kid"
      search-placeholder="Filter by kid…"
      :filter-facets="facets"
      :meta="tableMeta"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No keys match these filters."
      @row-click="(row) => (row as Key).scope_id && router.push(`/scopes/${(row as Key).scope_id}`)"
      @prev="goPrev"
      @next="goNext"
    />

    <ConfirmDestructive
      v-if="pendingKey"
      v-model:open="confirmOpen"
      title="Rotate signing key"
      description="Provisions a successor key and marks this one `retiring`. Existing tokens keep verifying against the retiring key until it expires; new tokens are signed with the successor from this moment forward."
      :confirm-phrase="pendingKey.kid"
      action-label="Rotate key"
      :pending="actionPending"
      @confirm="onConfirmRotate"
    />

    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New signing key</DialogTitle>
          <DialogDescription>
            Provisions a new signing key bound to a scope. The server generates the
            keypair and stores the private half in the KMS — only the public PEM is
            returned.
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
                  <option v-for="s in scopes" :key="s.id" :value="s.id">{{ s.slug }}</option>
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

          <createForm.Field name="kid">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  kid
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  class="font-mono"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="acme-prod-2026-04"
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

          <createForm.Field name="alg">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Algorithm
                </Label>
                <select
                  :id="field.name"
                  :value="state.value"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  @change="(e) => field.handleChange((e.target as HTMLSelectElement).value as KeyAlg)"
                >
                  <option v-for="a in KeyAlgValues" :key="a" :value="a">{{ a }}</option>
                </select>
              </div>
            </template>
          </createForm.Field>

          <createForm.Field name="role">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Role
                </Label>
                <select
                  :id="field.name"
                  :value="state.value"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  @change="(e) => field.handleChange((e.target as HTMLSelectElement).value as 'signing' | 'root')"
                >
                  <option value="signing">signing</option>
                  <option value="root">root</option>
                </select>
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
                  {{ isSubmitting ? 'Working…' : 'Create key' }}
                </Button>
              </template>
            </createForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
