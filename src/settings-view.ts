import { requiredElement } from './boundaries.ts';
import type { ResourceState, ResourceStates } from './resource-state.ts';
import type { Corpus } from './types.ts';

export function settingsCollectionStatus(corpus: Corpus, state: ResourceState) {
  switch (state.phase) {
    case 'ready': return { label: 'Ready to search', detail: '' };
    case 'saved': return { label: 'Downloaded', detail: 'Opens when selected.' };
    case 'missing': return {
      label: corpus === 'nfcorpus' ? 'Not set up' : 'Not downloaded',
      detail: corpus === 'nfcorpus' ? 'Set up this small collection once in this browser.' : 'One-time download saved in this browser.',
    };
    case 'checking': return { label: 'Checking…', detail: '' };
    case 'opening': return { label: 'Opening…', detail: state.message };
    case 'preparing': return { label: 'Setting up…', detail: state.message };
    case 'downloading': return { label: 'Downloading…', detail: state.message };
    case 'unsupported': return { label: 'Unavailable', detail: 'Search needs a supported browser on HTTPS or localhost.' };
    default: return { label: 'Needs attention', detail: state.message };
  }
}

export function setupSettingsView(states: ResourceStates, chooser: { search(corpus: Corpus): void }) {
  const rows = (['nfcorpus', 'msmarco'] as const).map(corpus => {
    const prefix = corpus === 'nfcorpus' ? 'fts' : 'marco';
    const row = requiredElement<HTMLElement>(`#setup-${corpus}`);
    const badge = requiredElement<HTMLElement>(`#${prefix}-settings-state`);
    const detail = requiredElement<HTMLElement>(`#${prefix}-status`);
    const search = requiredElement<HTMLButtonElement>(`#${prefix}-settings-search`);
    search.onclick = () => {
      if (!search.hidden && !search.disabled) chooser.search(corpus);
    };
    return { corpus, row, badge, detail, search };
  });
  const modelDetail = requiredElement<HTMLElement>('#llm-settings-detail');
  const unsubscribe = states.watch(state => [state.resources.nfcorpus, state.resources.msmarco, state.busy, state.resources.model.phase === 'unsupported'], () => {
    for (const { corpus, row, badge, detail, search } of rows) {
      const state = states.get(corpus);
      const status = settingsCollectionStatus(corpus, state);
      row.setAttribute('data-phase', state.phase);
      badge.textContent = status.label;
      detail.textContent = status.detail;
      detail.hidden = !status.detail;
      search.hidden = !['saved', 'ready'].includes(state.phase);
      search.disabled = search.hidden || states.busy;
    }
    modelDetail.hidden = states.get('model').phase !== 'unsupported';
    modelDetail.textContent = modelDetail.hidden ? '' : 'This device cannot generate AI answers. Document search remains available.';
  });
  return { dispose: unsubscribe };
}
