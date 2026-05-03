<script lang="ts">
import type { HTMLAttributes } from 'vue';
import type { ChartConfig } from '.';
import { useId } from 'reka-ui';
import { computed, toRefs } from 'vue';
import { cn } from '~/lib/utils';
import { provideChartContext } from '.';
import ChartStyle from './ChartStyle.vue';
</script>

<script setup lang="ts">
const props = defineProps<{
  id?: HTMLAttributes['id'];
  class?: HTMLAttributes['class'];
  config: ChartConfig;
  cursor?: boolean;
}>();

defineSlots<{
  default: (props: { id: string; config: ChartConfig }) => unknown;
}>();

const { config } = toRefs(props);
const uniqueId = useId();
const chartId = computed(() => `chart-${props.id || uniqueId.replace(/:/g, '')}`);

provideChartContext({
  id: uniqueId,
  config,
});
</script>

<template>
  <div
    data-slot="chart"
    :data-chart="chartId"
    :class="
      cn(
        // Full-bleed inside the parent + tighten unovis defaults
        // (transparent tooltip backdrop so our own ChartTooltipContent
        // styling lands on a clean canvas).
        '[&_[data-vis-xy-container]]:h-full [&_[data-vis-xy-container]]:w-full [&_[data-vis-single-container]]:h-full [&_[data-vis-single-container]]:w-full flex h-full w-full flex-col text-xs',
        props.class,
      )
    "
    :style="{
      // Strip unovis's own tooltip frame so our ChartTooltipContent
      // ships its own card.
      '--vis-tooltip-padding': '0px',
      '--vis-tooltip-background-color': 'transparent',
      '--vis-tooltip-border-color': 'transparent',
      '--vis-tooltip-text-color': 'none',
      '--vis-tooltip-shadow-color': 'none',
      '--vis-tooltip-backdrop-filter': 'none',
      // Crosshair: hide the dot, keep a faint vertical line when
      // `cursor` is set; both override unovis's blue defaults so the
      // chart inherits the design system's contrast in light + dark.
      '--vis-crosshair-circle-stroke-color': '#0000',
      '--vis-crosshair-line-stroke-width': cursor ? '1px' : '0px',
      '--vis-crosshair-line-stroke-color': 'var(--border)',
      // Axis ticks + lines pick up the design tokens so they retint
      // automatically when the user toggles dark mode. Without these
      // the unovis defaults (#888-ish) read too dark on light cards
      // and too light on dark cards.
      '--vis-axis-tick-color': 'var(--border)',
      '--vis-axis-domain-color': 'var(--border)',
      '--vis-axis-tick-label-color': 'var(--muted-foreground)',
      '--vis-axis-grid-color': 'var(--border)',
      '--vis-font-family': 'var(--font-sans)',
    }"
  >
    <slot :id="uniqueId" :config="config" />
    <ChartStyle :id="chartId" />
  </div>
</template>
