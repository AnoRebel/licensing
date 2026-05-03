<script setup lang="ts">
import LicenseOverviewWidget from '~/components/dashboard/LicenseOverviewWidget.vue';
import ExpiringSoonWidget from '~/components/dashboard/ExpiringSoonWidget.vue';
import RecentActivationsWidget from '~/components/dashboard/RecentActivationsWidget.vue';
import SeatUtilizationWidget from '~/components/dashboard/SeatUtilizationWidget.vue';

/**
 * Dashboard — four widgets, each independently owning its data fetch.
 *
 * Failure isolation: each widget renders inside its own <Suspense>
 * boundary, with a small skeleton fallback. A 500 from one upstream
 * endpoint blanks only that widget — the others keep their data and
 * stay readable. This matches the spec's "never blocks others"
 * requirement and gives operators something to work with even when
 * the issuer is misbehaving on one collection.
 *
 * The page itself does no data fetching; everything composes from
 * widget-level useLicensing calls. That keeps this file as the
 * stable layout shell while individual widget contracts evolve.
 */

useHead({ title: 'Dashboard — Licensing Admin' });

// Suspense fallback skeleton — one card-shaped placeholder per widget.
// Shown while the widget's top-level await resolves.
function widgetSkeleton(label: string) {
  return h('section', { 'aria-label': label, 'aria-busy': 'true' }, [
    h('div', {
      class:
        'h-32 w-full animate-pulse rounded-md border border-border bg-card',
    }),
  ]);
}
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-1">
      <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
        overview
      </p>
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
    </header>

    <Suspense>
      <LicenseOverviewWidget />
      <template #fallback>
        <component :is="() => widgetSkeleton('License overview loading')" />
      </template>
    </Suspense>

    <!--
      Two-up grid for the chart-bearing widgets. `min-w-0` on each cell
      lets the unovis containers actually shrink when the column is
      narrow — without it, the SVG's intrinsic width would stretch the
      column past 50% and break the layout on tablet widths.
    -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      <Suspense>
        <ExpiringSoonWidget />
        <template #fallback>
          <component :is="() => widgetSkeleton('Expiring licenses loading')" />
        </template>
      </Suspense>

      <Suspense>
        <RecentActivationsWidget />
        <template #fallback>
          <component :is="() => widgetSkeleton('Recent activations loading')" />
        </template>
      </Suspense>
    </div>

    <Suspense>
      <SeatUtilizationWidget />
      <template #fallback>
        <component :is="() => widgetSkeleton('Seat utilisation loading')" />
      </template>
    </Suspense>
  </div>
</template>
