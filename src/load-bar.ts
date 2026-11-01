import type { ResourceState } from './resource-state.ts';

// Every model and index load shows the same long bar: a real percentage when one is
// measured, otherwise a sliding stripe that never claims progress it cannot measure.
export function renderLoadBar(bar: HTMLProgressElement, visible: boolean, percent?: number) {
  bar.hidden = !visible;
  if (visible && percent !== undefined) bar.value = percent;
  else bar.removeAttribute?.('value');
}

const INDEX_LOADING = new Set<ResourceState['phase']>(['opening', 'preparing', 'downloading']);
export function renderIndexLoadBar(bar: HTMLProgressElement, state: ResourceState) {
  renderLoadBar(bar, INDEX_LOADING.has(state.phase), state.phase === 'downloading' ? state.progress : undefined);
}
