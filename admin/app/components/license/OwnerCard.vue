<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';

/**
 * Owner card on the license detail page.
 *
 * The licensing service doesn't know who the licensable actually is —
 * that's consumer-side knowledge (their User table, Organisation,
 * etc.). The convention is for the consumer to expose
 * `/owners/{type}/{id}` on their own API and the admin proxy forwards
 * to it; the response shape is whatever the consumer wants but we
 * surface a small set of well-known fields if they appear:
 *   - name
 *   - email
 *   - avatar_url
 *
 * If the resolver isn't configured (404) or fails (500/network), we
 * gracefully degrade to the licensable_type:licensable_id pair so the
 * operator still has the canonical attachment string. This is
 * deliberate — the rest of the detail page is fully usable without an
 * owner resolver, and we don't want to fail the page on a missing
 * sibling service.
 *
 * The component owns its own fetch (no top-level await) because it
 * sits inside <Suspense> on the detail page; we want the page to
 * render even if the resolver is slow.
 */

interface Props {
  licensableType: string;
  licensableId: string;
}
const props = defineProps<Props>();

interface OwnerEnvelope {
  data?: {
    name?: string;
    email?: string;
    avatar_url?: string;
    [k: string]: unknown;
  };
}

const owner = ref<OwnerEnvelope['data'] | null>(null);
const pending = ref(true);
const errorState = ref<'unconfigured' | 'failed' | null>(null);

const proxyPath = computed(
  () => `/api/proxy/owners/${encodeURIComponent(props.licensableType)}/${encodeURIComponent(props.licensableId)}`,
);

watchEffect(async () => {
  pending.value = true;
  errorState.value = null;
  owner.value = null;
  try {
    const res = await $fetch<OwnerEnvelope>(proxyPath.value, {
      method: 'GET',
      // Don't surface a fetch error on 4xx — those are "resolver
      // not implemented" / "owner unknown", which we render as a
      // benign empty state rather than the destructive red error
      // that 5xx warrants.
      ignoreResponseError: true,
    });
    owner.value = res?.data ?? null;
    if (!res?.data) errorState.value = 'unconfigured';
  } catch {
    errorState.value = 'failed';
  } finally {
    pending.value = false;
  }
});

const fallback = computed(
  () => `${props.licensableType}:${props.licensableId}`,
);
</script>

<template>
  <section
    aria-labelledby="owner-card-heading"
    class="rounded-md border border-border bg-card"
  >
    <header class="flex items-baseline justify-between border-b border-border px-4 py-3">
      <h2
        id="owner-card-heading"
        class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground"
      >
        owner
      </h2>
      <span class="font-mono text-[10px] text-muted-foreground" :title="fallback">
        {{ licensableType }}
      </span>
    </header>

    <div v-if="pending" class="space-y-2 p-4" aria-busy="true">
      <div class="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div class="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
    <div v-else-if="owner" class="flex items-center gap-3 p-4">
      <img
        v-if="owner.avatar_url"
        :src="owner.avatar_url"
        :alt="`${owner.name ?? fallback} avatar`"
        class="h-10 w-10 rounded-full border border-border bg-muted object-cover"
      />
      <div
        v-else
        aria-hidden="true"
        class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted font-mono text-xs"
      >
        {{ (owner.name ?? fallback).slice(0, 2).toUpperCase() }}
      </div>
      <div class="min-w-0 space-y-0.5">
        <p class="truncate text-sm font-semibold tracking-tight">
          {{ owner.name ?? fallback }}
        </p>
        <p v-if="owner.email" class="truncate font-mono text-xs text-muted-foreground">
          {{ owner.email }}
        </p>
        <p v-else class="truncate font-mono text-xs text-muted-foreground">
          {{ fallback }}
        </p>
      </div>
    </div>
    <div v-else class="space-y-1 p-4">
      <p class="text-sm">{{ fallback }}</p>
      <p class="text-xs text-muted-foreground">
        <template v-if="errorState === 'failed'">
          Owner resolver returned an error. The license is still fully editable.
        </template>
        <template v-else>
          Owner resolver isn't wired for this consumer. Implement
          <code>GET&nbsp;/owners/{type}/{id}</code> on your API to surface name and
          contact info here.
        </template>
      </p>
    </div>
  </section>
</template>
