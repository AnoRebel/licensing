<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';
import type { FilterFacet } from '~/components/DataTable/types';
import { usageColumns, type UsageTableMeta } from './columns';

type Usage = components['schemas']['Usage'];
type UsageStatus = components['schemas']['UsageStatus'];

/**
 * Global usages index.
 *
 * Filters:
 *   - Server-side: `license_id` (UUID), `status` (active/revoked). URL-query
 *     backed so operators can paste a link into an incident ticket.
 *   - Client-side: free-text on fingerprint, faceted filter on status (on
 *     the current page only).
 *
 * Row actions:
 *   - Row click → `/licenses/{license_id}` for drill-down.
 *   - Per-row Revoke opens the shared ConfirmDestructive (typed-to-confirm
 *     on the fingerprint prefix, matching the pattern on the license
 *     detail page).
 */

useHead({ title: 'Usages — Licensing Admin' });

const route = useRoute();
const router = useRouter();

const licenseIdQuery = computed(() =>
  typeof route.query.license_id === 'string' ? route.query.license_id : undefined,
);
const statusQuery = computed(() =>
  typeof route.query.status === 'string' ? (route.query.status as UsageStatus) : undefined,
);
const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

const listQuery = computed(() => ({
  limit: 50,
  cursor: cursorQuery.value,
  license_id: licenseIdQuery.value,
  status: statusQuery.value,
}));

const { data, pending, error, refresh } = await useLicensing('/admin/usages', {
  query: listQuery,
  key: 'admin-usages-list',
  watch: [listQuery],
});

const items = computed<Usage[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

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

const hasActiveServerFilters = computed(() => Boolean(licenseIdQuery.value || statusQuery.value));

// --- Client-side (TanStack) facets --------------------------------------
const STATUSES: UsageStatus[] = ['active', 'revoked'];
const facets: FilterFacet[] = [
  {
    columnId: 'status',
    title: 'Status (on page)',
    options: STATUSES.map((s) => ({ label: s, value: s })),
  },
];

// --- Revoke action ------------------------------------------------------
const { $licensing } = useNuxtApp();
const confirmOpen = ref(false);
const actionPending = ref(false);
const pendingUsage = ref<Usage | null>(null);

function openConfirmRevoke(usage: Usage) {
  pendingUsage.value = usage;
  confirmOpen.value = true;
}

async function onConfirmRevoke() {
  if (!pendingUsage.value) return;
  actionPending.value = true;
  try {
    await $licensing('/admin/usages/{id}/revoke', {
      method: 'POST',
      path: { id: pendingUsage.value.id },
    });
    toast.success('Usage revoked');
    confirmOpen.value = false;
    pendingUsage.value = null;
    await refresh();
  } catch (e) {
    toast.error(errorMessage(e, 'Could not revoke usage'));
  } finally {
    actionPending.value = false;
  }
}

const tableMeta = computed<UsageTableMeta>(() => ({
  onRevoke: (usage: Usage) => openConfirmRevoke(usage),
}));

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
  error.value ? 'Could not load usages. Check the upstream API.' : null,
);
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          resource
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Usages</h1>
      </div>
      <Button variant="outline" size="sm" @click="refresh()">Refresh</Button>
    </header>

    <section
      aria-label="Server filters"
      class="grid grid-cols-1 gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2"
    >
      <div class="space-y-1.5">
        <Label for="server-license" class="text-xs font-normal text-muted-foreground">
          License
          <span class="text-muted-foreground">(id)</span>
        </Label>
        <Input
          id="server-license"
          :model-value="licenseIdQuery ?? ''"
          placeholder="uuid"
          class="font-mono text-xs"
          @change="(e: Event) => applyServerFilter({ license_id: (e.target as HTMLInputElement).value || undefined, cursor: undefined })"
        />
      </div>

      <div class="space-y-1.5">
        <Label for="server-status" class="text-xs font-normal text-muted-foreground">
          Status
        </Label>
        <select
          id="server-status"
          :value="statusQuery ?? ''"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="(e) => applyServerFilter({ status: (e.target as HTMLSelectElement).value || undefined, cursor: undefined })"
        >
          <option value="">any status</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
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

    <p v-if="errorText" role="alert" class="text-sm text-destructive">
      {{ errorText }}
    </p>

    <DataTable
      v-else
      :columns="usageColumns"
      :data="items"
      :loading="pending"
      search-column="fingerprint"
      search-placeholder="Filter by fingerprint…"
      :filter-facets="facets"
      :meta="tableMeta"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No usages match these filters."
      @row-click="(row) => router.push(`/licenses/${(row as Usage).license_id}`)"
      @prev="goPrev"
      @next="goNext"
    />

    <ConfirmDestructive
      v-if="pendingUsage"
      v-model:open="confirmOpen"
      title="Revoke usage"
      description="Revokes this fingerprint. The client's offline token keeps working until its `exp`, but no new tokens are issued. No undo."
      :confirm-phrase="pendingUsage.fingerprint.slice(0, 12)"
      action-label="Revoke usage"
      :pending="actionPending"
      @confirm="onConfirmRevoke"
    />
  </div>
</template>
