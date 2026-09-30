import { requiredElement } from './boundaries.ts';

// Selection is intentionally session-only: every page load starts at the chooser.
export function setupCollectionChooser() {
  const start = requiredElement<HTMLSelectElement>('#collection-start');
  const swap = requiredElement<HTMLSelectElement>('#collection-switch');
  const welcome = requiredElement<HTMLElement>('#collection-welcome');
  const workspace = requiredElement<HTMLElement>('#search-workspace');
  const nav = requiredElement<HTMLElement>('#workspace-nav');
  const panels = {
    nfcorpus: requiredElement<HTMLElement>('#nfcorpus-collection'),
    msmarco: requiredElement<HTMLElement>('#msmarco-collection'),
  };
  function select(value: string) {
    if (!Object.hasOwn(panels, value)) return;
    start.value = swap.value = value;
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== value;
    // Move the shared controls without recreating the model or its event handlers.
    requiredElement<HTMLElement>(value === 'nfcorpus' ? '#fts-search-tools' : '#marco-search-tools')
      .append(requiredElement<HTMLElement>('#model'));
    welcome.hidden = true;
    workspace.hidden = false;
    nav.hidden = false;
    requiredElement<HTMLAnchorElement>('.skip-link').href = '#collections';
    requiredElement<HTMLAnchorElement>('.skip-link').textContent = 'Skip to search';
    requiredElement<HTMLInputElement>(value === 'nfcorpus' ? '#fts-query' : '#marco-query').focus({ preventScroll: true });
    requiredElement<HTMLElement>('#collections').scrollIntoView({ block: 'start' });
  }
  start.value = swap.value = '';
  welcome.hidden = false;
  workspace.hidden = nav.hidden = true;
  for (const panel of Object.values(panels)) panel.hidden = true;
  start.onchange = () => select(start.value);
  swap.onchange = () => select(swap.value);
}
