<script setup lang="ts">
import type { Column } from '@tanstack/vue-table';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, EyeOffIcon } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

/**
 * Sortable column header. Clicks cycle asc → desc → unsorted; the caret
 * reflects the current sort state. Hidden behind a dropdown to give the
 * operator "asc / desc / hide" as explicit options rather than guessing
 * which click does what.
 *
 * Column type is erased to `any, unknown` so that column defs typed with
 * a specific TData (e.g. `ColumnDef<License>`) flow through `h()` without
 * generic-variance errors. The header body doesn't use TData at all.
 */

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column: Column<any, unknown>;
  title: string;
}

defineProps<Props>();
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
