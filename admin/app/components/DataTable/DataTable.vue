<script setup lang="ts" generic="TData, TValue">
import type {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  Table as TableInstance,
  VisibilityState,
} from '@tanstack/vue-table';
import {
  FlexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useVueTable,
} from '@tanstack/vue-table';
import { computed, ref, watch } from 'vue';
import { valueUpdater } from '~/lib/utils';
import DataTablePagination from './DataTablePagination.vue';
import DataTableToolbar from './DataTableToolbar.vue';
import type { FilterFacet } from './types';

/**
 * Generic DataTable built on @tanstack/vue-table + shadcn-vue `Table`
 * primitives. Single source of truth for list pages in this app.
 *
 * Two pagination modes:
 *   - `client`  (default): the table owns pagination; use for small,
 *     fully-loaded datasets like scopes/templates where the API already
 *     gives us everything in one page.
 *   - `cursor`: pagination is server-driven. The parent passes
 *     `nextCursor` and handles `@prev`/`@next` to mutate the route query.
 *     Use for licenses/usages/audit where the server's `next_cursor`
 *     contract is the only truth.
 *
 * `toolbar = false` hides the filter row (use for embedded tables on
 * detail pages where a separate toolbar would be noise).
 */

interface Props {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Client-side free-text filter column id (e.g. `'license_key'`). */
  searchColumn?: string;
  searchPlaceholder?: string;
  filterFacets?: FilterFacet[];
  toolbar?: boolean;
  loading?: boolean;
  /** `'client'` to use @tanstack's page model, `'cursor'` for server-cursor mode. */
  paginationMode?: 'client' | 'cursor';
  /** Only meaningful in `'cursor'` mode: enables the Next button. */
  nextCursor?: string | null;
  /** Only meaningful in `'cursor'` mode: enables the Prev button. */
  canGoPrev?: boolean;
  initialPageSize?: number;
  emptyMessage?: string;
  /**
   * Forwarded to @tanstack/vue-table's `meta` option. Columns read this
   * via `table.options.meta` inside their `cell` render — used for row
   * action callbacks that don't belong on the row data itself. Typed as
   * `object | undefined` so any caller-defined interface flows through.
   */
  meta?: object;
}

const props = withDefaults(defineProps<Props>(), {
  searchColumn: undefined,
  searchPlaceholder: undefined,
  filterFacets: () => [],
  toolbar: true,
  loading: false,
  paginationMode: 'client',
  nextCursor: null,
  canGoPrev: false,
  initialPageSize: 25,
  emptyMessage: 'No results.',
  meta: () => ({}),
});

const emit = defineEmits<{
  rowClick: [row: TData];
  prev: [];
  next: [];
}>();

const sorting = ref<SortingState>([]);
const columnFilters = ref<ColumnFiltersState>([]);
const columnVisibility = ref<VisibilityState>({});
const rowSelection = ref({});

// In cursor mode the parent owns pagination; we set a huge pageSize so
// the TanStack page model is effectively a no-op (all current rows land
// on page 1). Client mode uses the initial pageSize and the page model
// handles slicing normally.
const effectivePageSize = computed(() =>
  props.paginationMode === 'cursor' ? Number.MAX_SAFE_INTEGER : props.initialPageSize,
);

const table = useVueTable({
  get data() {
    return props.data ?? [];
  },
  get columns() {
    return props.columns;
  },
  get meta() {
    return props.meta;
  },
  initialState: {
    pagination: { pageSize: effectivePageSize.value },
  },
  state: {
    get sorting() {
      return sorting.value;
    },
    get columnFilters() {
      return columnFilters.value;
    },
    get columnVisibility() {
      return columnVisibility.value;
    },
    get rowSelection() {
      return rowSelection.value;
    },
  },
  enableRowSelection: false,
  onSortingChange: (u) => valueUpdater(u, sorting),
  onColumnFiltersChange: (u) => valueUpdater(u, columnFilters),
  onColumnVisibilityChange: (u) => valueUpdater(u, columnVisibility),
  onRowSelectionChange: (u) => valueUpdater(u, rowSelection),
  getCoreRowModel: getCoreRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFacetedRowModel: getFacetedRowModel(),
  getFacetedUniqueValues: getFacetedUniqueValues(),
  getPaginationRowModel: getPaginationRowModel(),
});

// When the underlying dataset changes (e.g. refetch on filter change),
// reset the page index to 0 so we don't land on an empty tail page.
watch(
  () => props.data,
  () => {
    if (props.paginationMode === 'client') table.setPageIndex(0);
  },
);

defineExpose({ table });
</script>

<template>
  <div class="space-y-4">
    <DataTableToolbar
      v-if="toolbar"
      :table="(table as unknown as TableInstance<unknown>)"
      :search-column="searchColumn"
      :search-placeholder="searchPlaceholder"
      :filter-facets="filterFacets"
    />

    <div class="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow
            v-for="headerGroup in table.getHeaderGroups()"
            :key="headerGroup.id"
          >
            <TableHead
              v-for="header in headerGroup.headers"
              :key="header.id"
              :colspan="header.colSpan"
            >
              <FlexRender
                v-if="!header.isPlaceholder"
                :render="header.column.columnDef.header"
                :props="header.getContext()"
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="loading && table.getRowModel().rows.length === 0">
            <TableRow v-for="n in 6" :key="`sk-${n}`">
              <TableCell
                v-for="col in columns"
                :key="`${n}-${col.id ?? 'c'}`"
              >
                <Skeleton class="h-4 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <template v-else-if="table.getRowModel().rows.length > 0">
            <TableRow
              v-for="row in table.getRowModel().rows"
              :key="row.id"
              :class="$attrs.onRowClick ? 'cursor-pointer hover:bg-muted/50' : undefined"
              @click="emit('rowClick', row.original)"
            >
              <TableCell
                v-for="cell in row.getVisibleCells()"
                :key="cell.id"
              >
                <FlexRender
                  :render="cell.column.columnDef.cell"
                  :props="cell.getContext()"
                />
              </TableCell>
            </TableRow>
          </template>

          <TableRow v-else>
            <TableCell :colspan="columns.length" class="h-24 text-center text-sm text-muted-foreground">
              {{ emptyMessage }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <DataTablePagination
      :table="(table as unknown as TableInstance<unknown>)"
      :mode="paginationMode"
      :next-cursor="nextCursor"
      :can-go-prev="canGoPrev"
      :row-count="data.length"
      @prev="emit('prev')"
      @next="emit('next')"
    />
  </div>
</template>
