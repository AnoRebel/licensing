import { isClient } from '@vueuse/core';
import { useId } from 'reka-ui';
import { h, render } from 'vue';
import type { ChartConfig } from '.';

// In-process cache so we don't re-render the tooltip vnode for the
// same data point on every mousemove. Key is `${chartId}-${jsonStable}`.
const cache = new Map<string, string>();

function serializeKey(key: Record<string, unknown>): string {
  return JSON.stringify(key, Object.keys(key).sort());
}

interface Constructor<P = Record<string, unknown>> {
  __isFragment?: never;
  __isTeleport?: never;
  __isSuspense?: never;
  new (
    ...args: unknown[]
  ): {
    $props: P;
  };
}

/**
 * Convert a Vue component into the inline HTML string unovis expects
 * for its `template` prop. The component is rendered to a detached
 * <div> with its `payload` / `config` / `x` props bound, then the
 * resulting innerHTML is cached and returned. Used for ChartTooltip
 * triggers and ChartCrosshair templates.
 *
 * https://unovis.dev/docs/auxiliary/Crosshair#component-props
 */
export function componentToString<P>(config: ChartConfig, component: Constructor<P>, props?: P) {
  if (!isClient) return;

  const id = useId();

  return (data_: unknown, x: number | Date) => {
    const data =
      data_ && typeof data_ === 'object' && 'data' in data_
        ? (data_ as { data: unknown }).data
        : data_;
    const serializedKey = `${id}-${serializeKey(data as Record<string, unknown>)}`;
    const cached = cache.get(serializedKey);
    if (cached) return cached;

    const vnode = h<unknown>(component, {
      ...props,
      payload: data,
      config,
      x,
    });
    const div = document.createElement('div');
    render(vnode, div);
    cache.set(serializedKey, div.innerHTML);
    return div.innerHTML;
  };
}
