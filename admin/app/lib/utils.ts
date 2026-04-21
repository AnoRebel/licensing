import type { Updater } from '@tanstack/vue-table';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Ref } from 'vue';

// Standard shadcn-vue className combiner. Kept verbatim so `npx shadcn-vue
// add <component>` output drops in without edits.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// TanStack Table's "Updater" pattern allows state updaters to be either a
// raw value OR a `(prev) => next` function. This helper applies either
// shape to a plain Vue ref so we don't have to branch on every state
// setter when wiring `useVueTable`.
export function valueUpdater<T extends Updater<unknown>>(updaterOrValue: T, ref: Ref) {
  ref.value =
    typeof updaterOrValue === 'function'
      ? (updaterOrValue as (prev: unknown) => unknown)(ref.value)
      : updaterOrValue;
}
