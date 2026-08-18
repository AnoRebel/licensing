<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed } from 'vue';

type Template = components['schemas']['Template'];

/**
 * Parent → current → children as an indented tree.
 *
 * Replaces a breadcrumb plus a flat child list. The breadcrumb read as
 * navigation history rather than structure, which matters here because
 * inheritance flows DOWN the chain: a child resolves its unset numeric
 * defaults from its ancestors, so seeing the depth is seeing the policy.
 *
 * Rendered as real nested lists so a screen reader announces the depth
 * rather than relying on indentation alone. The current template is marked
 * `aria-current="page"` and is the only node that is not a link.
 */

interface Props {
  /** Ancestors nearest-first, as the detail page resolves them. */
  ancestors: readonly Template[];
  current: Template;
  children: readonly Template[];
}

const props = defineProps<Props>();

// Root-first for rendering: the chain is stored nearest-ancestor-first
// because that is the order the resolver walks it.
const chain = computed(() => props.ancestors.slice().reverse());
</script>

<template>
  <nav aria-label="Template hierarchy" class="font-mono text-xs">
    <ol class="space-y-1">
      <li v-for="(a, depth) in chain" :key="a.id" :style="{ paddingLeft: `${depth * 14}px` }">
        <span v-if="depth > 0" aria-hidden="true" class="mr-1 text-muted-foreground">└</span>
        <NuxtLink
          :to="`/templates/${a.id}`"
          class="rounded px-1 py-0.5 underline-offset-2 hover:bg-muted hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {{ a.name }}
        </NuxtLink>
      </li>

      <li :style="{ paddingLeft: `${chain.length * 14}px` }">
        <span v-if="chain.length > 0" aria-hidden="true" class="mr-1 text-muted-foreground">└</span>
        <span aria-current="page" class="rounded bg-muted px-1 py-0.5 font-semibold">
          {{ current.name }}
        </span>
      </li>

      <li v-if="children.length > 0" :style="{ paddingLeft: `${(chain.length + 1) * 14}px` }">
        <ol class="space-y-1">
          <li v-for="c in children" :key="c.id">
            <span aria-hidden="true" class="mr-1 text-muted-foreground">└</span>
            <NuxtLink
              :to="`/templates/${c.id}`"
              class="rounded px-1 py-0.5 underline-offset-2 hover:bg-muted hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {{ c.name }}
            </NuxtLink>
            <span class="ml-2 text-muted-foreground">{{ c.id.slice(0, 8) }}</span>
          </li>
        </ol>
      </li>
    </ol>

    <p v-if="chain.length === 0 && children.length === 0" class="mt-1 text-muted-foreground">
      Standalone template — no parent, no children.
    </p>
  </nav>
</template>
