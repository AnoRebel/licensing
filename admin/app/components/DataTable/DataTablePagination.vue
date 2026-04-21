<script setup lang="ts" generic="TData">
import type { Table } from '@tanstack/vue-table';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from 'lucide-vue-next';

/**
 * Two-mode pagination UI.
 *
 * - `client`: full @tanstack/vue-table page model (first/prev/next/last +
 *   rows-per-page select). Used for fully-loaded datasets.
 * - `cursor`: simple Prev/Next driven by the parent via `@prev`/`@next`;
 *   the table has no idea how many pages exist. Used for server-cursor
 *   endpoints where "last page" is undefined.
 */

interface Props {
  table: Table<TData>;
  mode: 'client' | 'cursor';
  nextCursor?: string | null;
  canGoPrev?: boolean;
  /** Visible row count on the current page — for the "N rows" hint. */
  rowCount: number;
}

defineProps<Props>();

const emit = defineEmits<{
  prev: [];
  next: [];
}>();
</script>

<template>
  <div class="flex items-center justify-between px-2">
    <p class="flex-1 font-mono text-xs text-muted-foreground">
      {{ rowCount }} {{ rowCount === 1 ? 'row' : 'rows' }} on this page
    </p>

    <!-- Client-side pagination (all rows present) -->
    <div v-if="mode === 'client'" class="flex items-center gap-6 lg:gap-8">
      <div class="flex items-center gap-2">
        <p class="text-sm font-medium">Rows per page</p>
        <Select
          :model-value="`${table.getState().pagination.pageSize}`"
          @update:model-value="(v) => table.setPageSize(Number(v))"
        >
          <SelectTrigger class="h-8 w-[72px]">
            <SelectValue :placeholder="`${table.getState().pagination.pageSize}`" />
          </SelectTrigger>
          <SelectContent side="top">
            <SelectItem
              v-for="n in [10, 25, 50, 100]"
              :key="n"
              :value="`${n}`"
            >
              {{ n }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex w-[120px] items-center justify-center font-mono text-xs">
        Page {{ table.getState().pagination.pageIndex + 1 }} of {{ Math.max(1, table.getPageCount()) }}
      </div>

      <div class="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          :disabled="!table.getCanPreviousPage()"
          aria-label="Go to first page"
          @click="table.setPageIndex(0)"
        >
          <ChevronsLeftIcon class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          :disabled="!table.getCanPreviousPage()"
          aria-label="Go to previous page"
          @click="table.previousPage()"
        >
          <ChevronLeftIcon class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          :disabled="!table.getCanNextPage()"
          aria-label="Go to next page"
          @click="table.nextPage()"
        >
          <ChevronRightIcon class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          :disabled="!table.getCanNextPage()"
          aria-label="Go to last page"
          @click="table.setPageIndex(table.getPageCount() - 1)"
        >
          <ChevronsRightIcon class="size-4" />
        </Button>
      </div>
    </div>

    <!-- Server cursor pagination (no total, no last-page) -->
    <div v-else class="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        :disabled="!canGoPrev"
        @click="emit('prev')"
      >
        <ChevronLeftIcon class="mr-1 size-4" />
        Previous
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!nextCursor"
        @click="emit('next')"
      >
        Next
        <ChevronRightIcon class="ml-1 size-4" />
      </Button>
    </div>
  </div>
</template>
