<script setup lang="ts" generic="TData">
import type { Table } from '@tanstack/vue-table';
import { computed } from 'vue';
import { ChevronDown, RotateCcw } from 'lucide-vue-next';
import type { FilterFacet } from './types';

/**
 * Filter row above the table. Composes three concerns:
 *   - optional free-text search bound to a single column (client-side)
 *   - faceted filters (e.g. status enum) rendered as popovers
 *   - a "Columns" dropdown for showing/hiding columns
 *
 * Everything is wired through the TanStack Table instance — the parent
 * doesn't manage this state.
 */

interface Props {
  table: Table<TData>;
  /** Column id to bind the free-text filter to; omit to hide the search input. */
  searchColumn?: string;
  searchPlaceholder?: string;
  filterFacets?: FilterFacet[];
}

const props = withDefaults(defineProps<Props>(), {
  searchColumn: undefined,
  searchPlaceholder: 'Filter…',
  filterFacets: () => [],
});

const isFiltered = computed(() => props.table.getState().columnFilters.length > 0);

const searchValue = computed(() => {
  if (!props.searchColumn) return '';
  return (props.table.getColumn(props.searchColumn)?.getFilterValue() as string | undefined) ?? '';
});

function setSearch(v: string | number) {
  if (!props.searchColumn) return;
  props.table.getColumn(props.searchColumn)?.setFilterValue(v || undefined);
}
</script>

<template>
  <div class="flex items-center justify-between gap-2">
    <div class="flex flex-1 flex-wrap items-center gap-2">
      <Input
        v-if="searchColumn"
        :model-value="searchValue"
        :placeholder="searchPlaceholder"
        class="h-8 w-[220px] font-mono text-xs"
        @update:model-value="(v) => setSearch(v)"
      />

      <template v-for="facet in filterFacets" :key="facet.columnId">
        <DataTableFacetedFilter
          v-if="table.getColumn(facet.columnId)"
          :column="table.getColumn(facet.columnId)!"
          :title="facet.title"
          :options="facet.options"
        />
      </template>

      <Button
        v-if="isFiltered"
        variant="ghost"
        size="sm"
        class="h-8 px-2"
        @click="table.resetColumnFilters()"
      >
        Reset
        <RotateCcw class="ml-2 size-3.5" />
      </Button>
    </div>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="sm" class="hidden h-8 sm:inline-flex">
          Columns
          <ChevronDown class="ml-1 size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-[180px]">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          v-for="column in table.getAllColumns().filter((c) => c.getCanHide())"
          :key="column.id"
          class="capitalize"
          :model-value="column.getIsVisible()"
          @update:model-value="(v: boolean) => column.toggleVisibility(v)"
        >
          {{ column.id.replace(/_/g, ' ') }}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
