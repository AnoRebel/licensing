<script setup lang="ts" generic="TData">
import type { Table } from '@tanstack/vue-table';
import { ChevronDown } from 'lucide-vue-next';

/**
 * Stand-alone column-visibility dropdown. Mirrors the one inside
 * `DataTableToolbar` so callers can place it independently if they're
 * building their own toolbar layout.
 */

defineProps<{ table: Table<TData> }>();
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm" class="hidden h-8 lg:inline-flex">
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
</template>
