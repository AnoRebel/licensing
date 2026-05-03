// shadcn-vue chart wrappers around @unovis/vue. Mirrors the
// new-york-v4 registry layout but anchored on this project's
// ~/lib/utils alias and Tailwind v4 token names.
//
// Usage pattern:
//   <ChartContainer :config="chartConfig">
//     <VisXYContainer ...>
//       <VisStackedBar ... :color="chartConfig.foo.color" />
//       <ChartTooltip />
//       <ChartCrosshair :template="componentToString(chartConfig, ChartTooltipContent)" />
//     </VisXYContainer>
//   </ChartContainer>
//
// `chartConfig` keys map to CSS custom properties via ChartStyle —
// `chartConfig.active.color = 'hsl(var(--success))'` becomes
// `--color-active: hsl(var(--success))` scoped to the chart instance.
// The unovis components reference colors by string; pass the resolved
// CSS var (`var(--color-active)`) or the raw hsl(...) directly.

import { createContext } from 'reka-ui';
import type { Component, Ref } from 'vue';

export { default as ChartContainer } from './ChartContainer.vue';
export { default as ChartLegendContent } from './ChartLegendContent.vue';
export { default as ChartTooltipContent } from './ChartTooltipContent.vue';
export { componentToString } from './utils';

export const THEMES = { light: '', dark: '.dark' } as const;

export type ChartConfig = {
  [k in string]: {
    label?: string | Component;
    icon?: string | Component;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  );
};

interface ChartContextProps {
  id: string;
  config: Ref<ChartConfig>;
}

export const [useChart, provideChartContext] = createContext<ChartContextProps>('Chart');

export { VisCrosshair as ChartCrosshair, VisTooltip as ChartTooltip } from '@unovis/vue';
