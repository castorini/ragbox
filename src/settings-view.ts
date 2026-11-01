import { requiredElement } from './boundaries.ts';
import type { ResourceState, ResourceStates } from './resource-state.ts';
import type { Corpus } from './types.ts';
import { renderIndexLoadBar } from './load-bar.ts';

export function settingsCollectionDetail(state: ResourceState) {
  switch (state.phase) {
    case 'ready': return 'Ready to search.';
    case 'saved': return 'Downloaded. Opens when selected.';
    case 'missing': return 'One-time download saved in this browser.';
    case 'unsupported': return 'Search needs a supported browser on HTTPS or localhost.';
    default: return state.message;
  }
}

export function setupSettingsView(states: ResourceStates, chooser: { search(corpus: Corpus): void }) {
  const rows = (['nfcorpus', 'msmarco'] as const).map(corpus => {
    const prefix = corpus === 'nfcorpus' ? 'fts' : 'marco';
    const row = requiredElement<HTMLElement>(`#setup-${corpus}`);
    const detail = requiredElement<HTMLElement>(`#${prefix}-status`);
    const search = requiredElement<HTMLButtonElement>(`#${prefix}-settings-search`);
    const progress = requiredElement<HTMLProgressElement>(`#${prefix}-progress`);
    search.onclick = () => {
      if (!search.hidden && !search.disabled) chooser.search(corpus);
    };
    return { corpus, row, detail, search, progress };
  });
  const modelDetail = requiredElement<HTMLElement>('#llm-settings-detail');
  const unsubscribe = states.watch(state => [state.resources.nfcorpus, state.resources.msmarco, state.busy, state.resources.model.phase === 'unsupported'], () => {
    for (const { corpus, row, detail, search, progress } of rows) {
      const state = states.get(corpus);
      renderIndexLoadBar(progress, state);
      const text = settingsCollectionDetail(state);
      row.setAttribute('data-phase', state.phase);
      detail.textContent = text;
      detail.hidden = !text;
      search.hidden = !['saved', 'ready'].includes(state.phase);
      search.disabled = search.hidden || states.busy;
    }
    modelDetail.hidden = states.get('model').phase !== 'unsupported';
    modelDetail.textContent = modelDetail.hidden ? '' : 'This device cannot generate AI answers. Document search remains available.';
  });
  return { dispose: unsubscribe };
}
