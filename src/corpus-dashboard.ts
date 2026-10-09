import { requiredElement } from './boundaries.ts';
import type { ResourcePhase, ResourceStates } from './resource-state.ts';
import type { Corpus } from './types.ts';
import type { SetupActions } from './search-guidance.ts';

type Light = 'available' | 'unavailable' | 'pending';

interface CardStatus {
  light: Light;
  label: string;
  detail?: string;
  setup?: string;
}

interface DashboardChooser {
  selected(): Corpus;
  choose(value: Corpus): void;
  openSetup(corpus: Corpus): void;
  subscribe?(listener: () => void): () => void;
}

const corpora = {
  nfcorpus: { name: 'NFCorpus', missing: 'Not prepared', setup: 'Prepare NFCorpus' },
  msmarco: { name: 'MS MARCO', missing: 'Not downloaded', setup: 'Download MS MARCO index (3.35 GB)' },
} as const;

export function cardStatus(corpus: Corpus, phase: ResourcePhase, message: string): CardStatus {
  const info = corpora[corpus];
  switch (phase) {
    case 'ready': return { light: 'available', label: 'Ready to search' };
    case 'saved': return { light: 'available', label: 'Downloaded', detail: 'Opens automatically when you select it.' };
    case 'missing': return { light: 'unavailable', label: info.missing, setup: info.setup };
    case 'checking': return { light: 'pending', label: 'Checking…' };
    case 'opening': return { light: 'pending', label: 'Opening…', detail: message };
    case 'preparing': return { light: 'pending', label: 'Preparing…', detail: message };
    case 'downloading': return { light: 'pending', label: 'Downloading…', detail: message };
    case 'unsupported': return { light: 'unavailable', label: 'Not supported', detail: 'Use desktop Chrome on localhost or HTTPS.' };
    default: return { light: 'unavailable', label: 'Needs attention', detail: message, setup: 'Fix in Settings' };
  }
}

export function setupCorpusDashboard(states: ResourceStates, chooser: DashboardChooser, actions?: SetupActions) {
  const cards = (Object.keys(corpora) as Corpus[]).map(corpus => {
    const card = requiredElement<HTMLElement>(`.corpus-card[data-corpus="${corpus}"]`);
    const label = requiredElement<HTMLElement>(`#${corpus}-dashboard-status`);
    const detail = requiredElement<HTMLElement>(`#${corpus}-dashboard-detail`);
    const setup = requiredElement<HTMLButtonElement>(`#${corpus}-dashboard-setup`);
    const use = requiredElement<HTMLButtonElement>(`#${corpus}-dashboard-use`);
    const selectedBadge = requiredElement<HTMLElement>(`#${corpus}-dashboard-selected`);
    const defaultDetail = detail.textContent;
    setup.onclick = event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!actions || states.get(corpus).phase === 'error') { chooser.openSetup(corpus); return; }
      chooser.choose(corpus);
      if (corpus === 'nfcorpus') void actions.prepare();
      else void actions.download();
    };
    use.onclick = () => {
      chooser.choose(corpus);
      if (!chooser.subscribe) render();
    };
    return { corpus, card, label, detail, setup, use, selectedBadge, defaultDetail };
  });

  function render() {
    const selected = chooser.selected();
    for (const { corpus, card, label, detail, setup, use, selectedBadge, defaultDetail } of cards) {
      const { phase, message } = states.get(corpus);
      const status = cardStatus(corpus, phase, message);
      const isSelected = corpus === selected;
      card.setAttribute('data-status', status.light);
      card.setAttribute('data-selected', String(isSelected));
      label.textContent = status.label;
      detail.textContent = status.detail ?? defaultDetail;
      setup.hidden = !status.setup;
      setup.disabled = states.busy;
      setup.textContent = status.setup ?? '';
      use.setAttribute('aria-pressed', String(isSelected));
      selectedBadge.hidden = !isSelected;
    }
  }

  const unsubscribe = states.watch(state => [state.resources.nfcorpus, state.resources.msmarco, state.busy], render);
  const unsubscribeSelection = chooser.subscribe?.(render);
  return { render, dispose() { unsubscribe(); unsubscribeSelection?.(); } };
}
