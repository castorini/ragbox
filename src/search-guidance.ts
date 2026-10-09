import { requiredElement } from './boundaries.ts';
import { ResourceStates, type ResourceName, type ResourceState } from './resource-state.ts';

function guidance(name: ResourceName, state: ResourceState, busy: boolean): string {
  const label = name === 'nfcorpus' ? 'NFCorpus' : 'MS MARCO';
  if (busy && state.phase === 'ready') return 'Search is temporarily paused while another database operation finishes.';
  switch (state.phase) {
    case 'checking': return `Checking ${label} in this browser…`;
    case 'saved': return `Opening the saved ${label} index when you select this collection.`;
    case 'opening': return `Opening the saved ${label} index…`;
    case 'preparing':
    case 'downloading': return state.message;
    case 'missing': return `${label} needs an index before search is available.`;
    case 'error': return state.message.startsWith('Startup failed:')
      ? 'Startup failed. Reload this page to retry.'
      : `${label} could not be opened. Review the error and retry in Settings.`;
    case 'unsupported': return 'Search needs a supported browser on HTTPS or localhost.';
    default: return state.message;
  }
}

export interface SetupActions {
  prepare(): unknown;
  download(): unknown;
  openSaved(): unknown;
  cancelDownload(): unknown;
}

export function setupSearchGuidance(states: ResourceStates, actions?: SetupActions) {
  const unsubscribers: (() => void)[] = [];
  for (const [name, prefix] of [['nfcorpus', 'fts'], ['msmarco', 'marco']] as const) {
    const button = document.querySelector<HTMLButtonElement>(`#${prefix}-search`);
    const input = document.querySelector<HTMLInputElement>(`#${prefix}-query`);
    const form = document.querySelector<HTMLFormElement>(`#${prefix}-form`);
    const help = requiredElement<HTMLElement>(`#${prefix}-help`);
    const helpText = requiredElement<HTMLElement>(`#${prefix}-help-text`);
    button?.setAttribute('aria-describedby', `${prefix}-help`);
    input?.setAttribute('aria-describedby', `${prefix}-help`);
    unsubscribers.push(states.watch(state => [state.resources[name], state.busy, state.activeSearch], () => {
      const state = states.get(name);
      const unavailable = state.phase !== 'ready' || states.busy;
      if (button) button.disabled = unavailable;
      if (input) input.disabled = false;
      form?.classList.toggle('unavailable', unavailable);
      help.hidden = !unavailable || states.activeSearch === name;
      helpText.textContent = guidance(name, state, states.busy);
    }));
  }
  if (!actions) return { dispose() { for (const unsubscribe of unsubscribers) unsubscribe(); } };
  const prepare = requiredElement<HTMLButtonElement>('#fts-prepare');
  const download = requiredElement<HTMLButtonElement>('#marco-download');
  const open = requiredElement<HTMLButtonElement>('#marco-open');
  const cancel = requiredElement<HTMLButtonElement>('#marco-search-cancel');
  const progress = requiredElement<HTMLProgressElement>('#marco-search-progress');
  prepare.onclick = () => { void actions.prepare(); };
  download.onclick = () => { void actions.download(); };
  open.onclick = () => { void actions.openSaved(); };
  cancel.onclick = () => { actions.cancelDownload(); };
  unsubscribers.push(states.watch(state => [state.resources.nfcorpus, state.resources.msmarco, state.busy], () => {
    const nf = states.get('nfcorpus');
    const marco = states.get('msmarco');
    prepare.hidden = !['missing', 'error'].includes(nf.phase);
    prepare.disabled = states.busy || prepare.hidden;
    download.hidden = marco.phase !== 'missing' && !(marco.phase === 'error' && marco.savedAvailable === false);
    download.disabled = states.busy || download.hidden;
    open.hidden = marco.phase !== 'saved' && !(marco.phase === 'error' && marco.savedAvailable !== false);
    open.textContent = marco.phase === 'error' ? 'Retry opening collection' : 'Open downloaded collection';
    open.disabled = states.busy || open.hidden;
    cancel.hidden = marco.phase !== 'downloading';
    progress.hidden = marco.phase !== 'downloading';
    if (marco.progress === undefined) progress.removeAttribute?.('value');
    else progress.value = marco.progress;
  }));
  return { dispose() { for (const unsubscribe of unsubscribers) unsubscribe(); } };
}
