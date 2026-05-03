<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed } from 'vue';
import { shortId } from '~/lib/datetime';

type Template = components['schemas']['Template'];

/**
 * Template card on the license detail page. Fetches the bound template
 * when `templateId` is set; renders the template's defaults + a link
 * to the dedicated /templates/{id} page so the operator can drill in
 * for full editing.
 *
 * When `templateId` is null we render an "ad-hoc license" notice
 * instead of the card body — that's the canonical reading of a license
 * without a template, not a missing-data error.
 *
 * Failures (404 / 500) render a small error caveat in the same shape
 * so the surrounding layout never collapses; this card is one of
 * several side-by-side cards in the detail rail.
 */

interface Props {
  templateId: string | null | undefined;
}
const props = defineProps<Props>();

const templateIdRef = computed(() => props.templateId ?? null);

// Conditional fetch — useLicensing always runs, but we drop the path
// to the empty UUID and skip rendering its result when null. Skipping
// the fetch entirely would trip the underlying `useAsyncData` pattern
// (no key reactivity), so we let it run and gate the render.
const { data, pending, error } = await useLicensing('/admin/templates/{id}', {
  path: { id: templateIdRef.value ?? '' },
  key: () => `license-detail-template-${templateIdRef.value ?? 'none'}`,
  watch: [templateIdRef],
  immediate: templateIdRef.value !== null,
});

const template = computed<Template | undefined>(() =>
  templateIdRef.value === null ? undefined : data.value?.data,
);

const errorMessage = computed(() =>
  templateIdRef.value !== null && error.value ? 'Could not load template' : null,
);
</script>

<template>
  <section
    aria-labelledby="template-card-heading"
    class="rounded-md border border-border bg-card"
  >
    <header class="flex items-baseline justify-between border-b border-border px-4 py-3">
      <h2
        id="template-card-heading"
        class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
      >
        template
      </h2>
      <NuxtLink
        v-if="template"
        :to="`/templates/${template.id}`"
        class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        view →
      </NuxtLink>
    </header>

    <p v-if="templateId === null" class="p-4 text-sm text-muted-foreground">
      Ad-hoc license — not bound to a template.
    </p>
    <div v-else-if="pending && !template" class="space-y-2 p-4" aria-busy="true">
      <div class="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div class="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div class="h-3 w-1/3 animate-pulse rounded bg-muted" />
    </div>
    <p v-else-if="errorMessage" role="alert" class="p-4 text-sm text-destructive">
      {{ errorMessage }}
    </p>
    <div v-else-if="template" class="space-y-3 p-4">
      <div class="space-y-1">
        <p class="text-sm font-semibold tracking-tight">{{ template.name }}</p>
        <p class="font-mono text-[10px] text-muted-foreground" :title="template.id">
          {{ shortId(template.id) }}
        </p>
      </div>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
        <div class="space-y-0.5">
          <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">max_usages</dt>
          <dd class="tabular-nums">{{ template.max_usages }}</dd>
        </div>
        <div class="space-y-0.5">
          <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">trial_sec</dt>
          <dd class="tabular-nums">{{ template.trial_duration_sec }}</dd>
        </div>
        <div class="space-y-0.5">
          <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">grace_sec</dt>
          <dd class="tabular-nums">{{ template.grace_duration_sec }}</dd>
        </div>
        <div class="space-y-0.5">
          <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">
            force_online_sec
          </dt>
          <dd class="tabular-nums">{{ template.force_online_after_sec ?? '—' }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
