<script setup lang="ts" generic="TData extends RowData">
import type { RowData } from '@tanstack/vue-table';
import type { AppColumn } from '~/lib/table';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, EyeOffIcon } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

/**
 * Sortable column header. Clicks cycle asc → desc → unsorted; the caret
 * reflects the current sort state. Hidden behind a dropdown to give the
 * operator "asc / desc / hide" as explicit options rather than guessing
 * which click does what.
 *
 * Generic over the row type. The header body never reads it, but v9's
 * `Column` is invariant in `TData` — no erased stand-in (`any`, `unknown`,
 * `RowData`, `Record<string, any>`) is assignable from a concrete column,
 * because `Column.parent` refers back to itself. Staying generic is the
 * only form that accepts `AppColumnDef<License>` and friends.
 */

interface Props<T extends RowData> {
  column: AppColumn<T, unknown>;
  title: string;
}

defineProps<Props<TData>>();
</script>

<template>
  <div v-if="column.getCanSort()" :class="cn('flex items-center gap-2', $attrs.class as string ?? '')">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          class="-ml-3 h-8 data-[state=open]:bg-accent"
        >
          <span>{{ title }}</span>
          <ArrowDownIcon v-if="column.getIsSorted() === 'desc'" class="ml-1.5 size-3.5" />
          <ArrowUpIcon v-else-if="column.getIsSorted() === 'asc'" class="ml-1.5 size-3.5" />
          <ChevronsUpDownIcon v-else class="ml-1.5 size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem @click="column.toggleSorting(false)">
          <ArrowUpIcon class="mr-2 size-3.5 text-muted-foreground" />
          Asc
        </DropdownMenuItem>
        <DropdownMenuItem @click="column.toggleSorting(true)">
          <ArrowDownIcon class="mr-2 size-3.5 text-muted-foreground" />
          Desc
        </DropdownMenuItem>
        <template v-if="column.getCanHide()">
          <DropdownMenuSeparator />
          <DropdownMenuItem @click="column.toggleVisibility(false)">
            <EyeOffIcon class="mr-2 size-3.5 text-muted-foreground" />
            Hide
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>

  <div v-else :class="$attrs.class as string">
    {{ title }}
  </div>
</template>
