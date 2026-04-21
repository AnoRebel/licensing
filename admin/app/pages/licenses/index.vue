<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import type { FilterFacet } from '~/components/DataTable/types';
import { licenseColumns } from './columns';

type License = components['schemas']['License'];
type LicenseStatus = components['schemas']['LicenseStatus'];

/**
 * Licenses index — DataTable + server-cursor pagination.
 *
 * Two filter dimensions, two layers:
 *   - Server-side (committed to the API): scope_id, template_id, licensable,
 *     status. URL-query-backed so links are shareable and back-button works.
 *   - Client-side (on the current page only): the free-text `assignee`
 *     search and the multi-select status facet. Useful for narrowing the
 *     25 rows the server just sent without paying another round-trip.
 *
 * Mixing strategies on purpose: server filters tell the server what slice
 * to return; client filters refine the slice we have in hand.
 */

useHead({ title: 'Licenses — Licensing Admin' });

const route = useRoute();
const router = useRouter();

// --- Server-side filters (URL-query-backed) -----------------------------
const statusQuery = computed(() =>
  typeof route.query.status === 'string' ? (route.query.status as LicenseStatus) : undefined,
);
const scopeQuery = computed(() =>
  typeof route.query.scope_id === 'string' ? route.query.scope_id : undefined,
);
const templateQuery = computed(() =>
  typeof route.query.template_id === 'string' ? route.query.template_id : undefined,
);
const licensableQuery = computed(() =>
  typeof route.query.licensable === 'string' ? route.query.licensable : undefined,
);
const cursorQuery = computed(() =>
  typeof route.query.cursor === 'string' && route.query.cursor.length > 0
    ? route.query.cursor
    : undefined,
);

// Scopes + templates feed the upstream-filter selects. Both small; one page is fine.
const { data: scopesData } = await useLicensing('/admin/scopes', { query: { limit: 100 } });
const { data: templatesData } = await useLicensing('/admin/templates', { query: { limit: 100 } });
const scopes = computed(() => scopesData.value?.data?.items ?? []);
const templates = computed(() => templatesData.value?.data?.items ?? []);

const listQuery = computed(() => ({
  limit: 25,
  cursor: cursorQuery.value,
  status: statusQuery.value,
  scope_id: scopeQuery.value,
  template_id: templateQuery.value,
  licensable: licensableQuery.value,
}));

const { data, pending, error, refresh } = await useLicensing('/admin/licenses', {
  query: listQuery,
  key: 'admin-licenses-list',
  watch: [listQuery],
});

const items = computed<License[]>(() => data.value?.data?.items ?? []);
const nextCursor = computed(() => data.value?.data?.next_cursor ?? null);

// Cursor history stack — server-cursor pagination gives us `next_cursor`
// but no way to go back, so we stack prior cursors as we advance.
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

const hasActiveServerFilters = computed(() =>
  Boolean(statusQuery.value || scopeQuery.value || templateQuery.value || licensableQuery.value),
);

// --- Client-side (TanStack) facets --------------------------------------
const STATUSES: LicenseStatus[] = ['pending', 'active', 'grace', 'expired', 'suspended', 'revoked'];
const facets: FilterFacet[] = [
  {
    columnId: 'status',
    title: 'Status (on page)',
    options: STATUSES.map((s) => ({ label: s, value: s })),
  },
];

const errorMessage = computed(() =>
  error.value ? 'Could not load licenses. Check the upstream API and try again.' : null,
);
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-baseline justify-between gap-4">
      <div class="space-y-1">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          resource
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">Licenses</h1>
      </div>
      <Button variant="outline" size="sm" @click="refresh()">
        Refresh
      </Button>
    </header>

    <!-- Server-side filter controls. Commit-on-change; no submit button. -->
    <section
      aria-label="Server filters"
      class="grid grid-cols-1 gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
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
        <Label for="server-template" class="text-xs font-normal text-muted-foreground">
          Template
        </Label>
        <select
          id="server-template"
          :value="templateQuery ?? ''"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="(e) => applyServerFilter({ template_id: (e.target as HTMLSelectElement).value || undefined, cursor: undefined })"
        >
          <option value="">any template</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">
            {{ t.name }}
          </option>
        </select>
      </div>

      <div class="space-y-1.5">
        <Label for="server-licensable" class="text-xs font-normal text-muted-foreground">
          Assignee
          <span class="text-muted-foreground">(type:id)</span>
        </Label>
        <Input
          id="server-licensable"
          :model-value="licensableQuery ?? ''"
          placeholder="user:42"
          class="font-mono text-xs"
          @change="(e: Event) => applyServerFilter({ licensable: (e.target as HTMLInputElement).value || undefined, cursor: undefined })"
        />
      </div>

      <div
        v-if="hasActiveServerFilters"
        class="sm:col-span-2 lg:col-span-4 flex items-center justify-end"
      >
        <Button variant="ghost" size="sm" @click="clearAllFilters">
          Clear server filters
        </Button>
      </div>
    </section>

    <p v-if="errorMessage" role="alert" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>

    <DataTable
      v-else
      :columns="licenseColumns"
      :data="items"
      :loading="pending"
      search-column="assignee"
      search-placeholder="Filter by assignee…"
      :filter-facets="facets"
      pagination-mode="cursor"
      :next-cursor="nextCursor"
      :can-go-prev="cursorStack.length > 0"
      empty-message="No licenses match these filters."
      @row-click="(row) => router.push(`/licenses/${(row as License).id}`)"
      @prev="goPrev"
      @next="goNext"
    />
  </div>
</template>
