import { requiredElement } from './boundaries.ts';
import { ResourceStates, type ResourceName, type ResourceState } from './resource-state.ts';

function guidance(name: ResourceName, state: ResourceState, busy: boolean): string {
  const label = name === 'nfcorpus' ? 'NFCorpus' : 'MS MARCO';
  if (busy && state.phase === 'ready') return 'Search is temporarily paused while another database operation finishes.';
  switch (state.phase) {
    case 'checking': return `Checking ${label} in this browser…`;
    case 'saved': return `Opening the saved ${label} index when you select this collection.`;
    case 'opening': return `Opening the saved ${label} index…`;
    case 'preparing': return `Preparing ${label} in this browser…`;
    case 'downloading': return `Downloading the ${label} index…`;
    case 'missing': return `${label} needs an index before search is available.`;
    case 'error': return state.message.startsWith('Startup failed:')
      ? 'Startup failed. Reload this page to retry.'
      : `${label} could not be opened. Review the error and retry in Setup.`;
    case 'unsupported': return 'Search needs a supported browser on HTTPS or localhost.';
    default: return state.message;
  }
}

export function setupSearchGuidance(states: ResourceStates) {
  for (const [name, prefix] of [['nfcorpus', 'fts'], ['msmarco', 'marco']] as const) {
    const button = requiredElement<HTMLButtonElement>(`#${prefix}-search`);
    const input = requiredElement<HTMLInputElement>(`#${prefix}-query`);
    const form = requiredElement<HTMLFormElement>(`#${prefix}-form`);
    const help = requiredElement<HTMLElement>(`#${prefix}-help`);
    const helpText = requiredElement<HTMLElement>(`#${prefix}-help-text`);
    button.setAttribute('aria-describedby', `${prefix}-help`);
    input.setAttribute('aria-describedby', `${prefix}-help`);
    states.subscribe(() => {
      const state = states.get(name);
      const unavailable = state.phase !== 'ready' || states.busy;
      button.disabled = unavailable;
      input.disabled = unavailable;
      form.classList.toggle('unavailable', unavailable);
      help.hidden = !unavailable || states.activeSearch === name;
      helpText.textContent = guidance(name, state, states.busy);
    });
  }
  const modelStatus = requiredElement<HTMLElement>('#model-search-status');
  states.subscribe(() => {
    const phase = states.get('model').phase;
    modelStatus.textContent = phase === 'ready' || phase === 'generating'
      ? 'Cited answers ready'
      : phase === 'loading' || phase === 'checking'
        ? 'Checking optional cited answers…'
        : 'Cited answers are optional';
  });
}
