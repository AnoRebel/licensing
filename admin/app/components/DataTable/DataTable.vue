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
import { computed, h, ref, watch } from 'vue';
import { valueUpdater } from '~/lib/utils';
import { Checkbox } from '~/components/ui/checkbox';
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
  /**
   * Enable row selection — prepends a checkbox column and emits
   * `selectionChange` with the array of selected row originals on every
   * change. The parent owns presentation of bulk-action UI.
   */
  selectable?: boolean;
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
  selectable: false,
});

const emit = defineEmits<{
  rowClick: [row: TData];
  prev: [];
  next: [];
  selectionChange: [rows: TData[]];
}>();

const sorting = ref<SortingState>([]);
const columnFilters = ref<ColumnFiltersState>([]);
const columnVisibility = ref<VisibilityState>({});
const rowSelection = ref<Record<string, boolean>>({});

// Synthesised selection column — prepended to props.columns when
// `selectable` is on. Header has a tri-state (unchecked / indeterminate
// / checked) controlled by the table's getIsAllPageRowsSelected /
// getIsSomePageRowsSelected helpers; row cells are plain checkboxes.
// Width is fixed so a row of bools doesn't push other columns around.
const selectColumn: ColumnDef<TData, TValue> = {
  id: '__select__',
  enableSorting: false,
  enableHiding: false,
  size: 32,
  header: ({ table }) =>
    h(Checkbox, {
      'modelValue':
        table.getIsAllPageRowsSelected() ||
        (table.getIsSomePageRowsSelected() ? 'indeterminate' : false),
      'aria-label': 'Select all rows on this page',
      'onUpdate:modelValue': (value: boolean | 'indeterminate') => {
        // reka-ui's Checkbox emits `'indeterminate'` only when the
        // *parent* sets it that way; clicking always toggles to a
        // boolean. Cast for the narrowing.
        table.toggleAllPageRowsSelected(value === true);
      },
    }),
  cell: ({ row }) =>
    h(Checkbox, {
      'modelValue': row.getIsSelected(),
      'aria-label': 'Select row',
      // Stop propagation so a row-level click handler doesn't fire when
      // the operator just wants to (de)select. Same trick used in the
      // shadcn-vue / TanStack examples.
      'onClick': (e: MouseEvent) => e.stopPropagation(),
      'onUpdate:modelValue': (value: boolean | 'indeterminate') => {
        row.toggleSelected(value === true);
      },
    }),
};

const effectiveColumns = computed<ColumnDef<TData, TValue>[]>(() =>
  props.selectable ? [selectColumn, ...props.columns] : props.columns,
);

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
    return effectiveColumns.value;
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
  // Honor the prop — TanStack treats `false` as "no row is selectable",
  // which is what we want when the parent didn't opt in.
  get enableRowSelection() {
    return props.selectable;
  },
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

// Forward the resolved row originals to the parent. We watch the
// internal selection state ref so the emit fires for every change
// (TanStack's onRowSelectionChange runs before the new state lands).
watch(
  rowSelection,
  () => {
    if (!props.selectable) return;
    const rows = table
      .getSelectedRowModel()
      .rows.map((r) => r.original as TData);
    emit('selectionChange', rows);
  },
  { deep: true },
);

// Reset selection when data changes — pagination across server cursors
// shouldn't preserve "selection on the previous page" because the row
// indices in the rowSelection map mean nothing on a new dataset.
watch(
  () => props.data,
  () => {
    rowSelection.value = {};
  },
);

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
              :aria-sort="
                header.column.getCanSort()
                  ? header.column.getIsSorted() === 'asc'
                    ? 'ascending'
                    : header.column.getIsSorted() === 'desc'
                      ? 'descending'
                      : 'none'
                  : undefined
              "
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
                v-for="col in effectiveColumns"
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
              :tabindex="$attrs.onRowClick ? 0 : undefined"
              :role="$attrs.onRowClick ? 'button' : undefined"
              @click="$attrs.onRowClick ? emit('rowClick', row.original) : undefined"
              @keydown="
                (e: KeyboardEvent) => {
                  if (!$attrs.onRowClick) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    emit('rowClick', row.original);
                  }
                }
              "
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
            <TableCell :colspan="effectiveColumns.length" class="h-24 text-center text-sm text-muted-foreground">
              <!--
                B21: empty state needs to be announced politely to SR
                users — otherwise an applied filter that yields no rows
                is invisible to anyone not looking at the viewport.
              -->
              <span role="status" aria-live="polite">{{ emptyMessage }}</span>
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
