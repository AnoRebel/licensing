<script setup lang="ts">
import type { Column } from '@tanstack/vue-table';
import { computed } from 'vue';
import { CheckIcon, PlusCircleIcon } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

/**
 * Multi-select facet filter for an enum-like column. Values are stored
 * as an array of selected option values; the column's filterFn must
 * treat that array as OR-membership.
 *
 * TData/TValue erased to `any, unknown` so callers can pass a
 * `Column<License>` (etc.) without generic-variance errors.
 */

interface FacetOption {
  label: string;
  value: string;
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column?: Column<any, unknown>;
  title?: string;
  options: FacetOption[];
}

const props = defineProps<Props>();

const facets = computed(() => props.column?.getFacetedUniqueValues());
const selectedValues = computed(
  () => new Set((props.column?.getFilterValue() as string[] | undefined) ?? []),
);

function toggle(value: string) {
  const next = new Set(selectedValues.value);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  const arr = Array.from(next);
  props.column?.setFilterValue(arr.length ? arr : undefined);
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" class="h-8 border-dashed">
        <PlusCircleIcon class="mr-2 size-3.5" />
        {{ title }}
        <template v-if="selectedValues.size > 0">
          <Separator orientation="vertical" class="mx-2 h-4" />
          <Badge variant="secondary" class="rounded-sm px-1 font-normal lg:hidden">
            {{ selectedValues.size }}
          </Badge>
          <div class="hidden gap-1 lg:flex">
            <Badge
              v-if="selectedValues.size > 2"
              variant="secondary"
              class="rounded-sm px-1 font-normal"
            >
              {{ selectedValues.size }} selected
            </Badge>
            <template v-else>
              <Badge
                v-for="opt in options.filter((o) => selectedValues.has(o.value))"
                :key="opt.value"
                variant="secondary"
                class="rounded-sm px-1 font-normal"
              >
                {{ opt.label }}
              </Badge>
            </template>
          </div>
        </template>
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-[220px] p-0" align="start">
      <Command>
        <CommandInput :placeholder="title" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="option in options"
              :key="option.value"
              :value="option.label"
              @select="toggle(option.value)"
            >
              <div
                :class="
                  cn(
                    'mr-2 flex size-4 items-center justify-center rounded-sm border border-primary',
                    selectedValues.has(option.value)
                      ? 'bg-primary text-primary-foreground'
                      : 'opacity-50 [&_svg]:invisible',
                  )
                "
              >
                <CheckIcon class="size-3.5" />
              </div>
              <span>{{ option.label }}</span>
              <span
                v-if="facets?.get(option.value)"
                class="ml-auto font-mono text-xs text-muted-foreground"
              >
                {{ facets.get(option.value) }}
              </span>
            </CommandItem>
          </CommandGroup>

          <template v-if="selectedValues.size > 0">
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__clear__"
                class="justify-center text-center"
                @select="column?.setFilterValue(undefined)"
              >
                Clear filter
              </CommandItem>
            </CommandGroup>
          </template>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
