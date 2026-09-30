// Selection is intentionally session-only: every page load starts at the chooser.
export function setupCollectionChooser() {
  const start = document.querySelector('#collection-start');
  const swap = document.querySelector('#collection-switch');
  const welcome = document.querySelector('#collection-welcome');
  const workspace = document.querySelector('#search-workspace');
  const nav = document.querySelector('#workspace-nav');
  const panels = {
    nfcorpus: document.querySelector('#nfcorpus-collection'),
    msmarco: document.querySelector('#msmarco-collection'),
  };
  function select(value) {
    if (!Object.hasOwn(panels, value)) return;
    start.value = swap.value = value;
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== value;
    // Move the shared controls without recreating the model or its event handlers.
    document.querySelector(value === 'nfcorpus' ? '#fts-search-tools' : '#marco-search-tools')
      .append(document.querySelector('#model'));
    welcome.hidden = true;
    workspace.hidden = false;
    nav.hidden = false;
    document.querySelector('.skip-link').href = '#collections';
    document.querySelector('.skip-link').textContent = 'Skip to search';
    document.querySelector(value === 'nfcorpus' ? '#fts-query' : '#marco-query').focus({ preventScroll: true });
    document.querySelector('#collections').scrollIntoView({ block: 'start' });
  }
  start.value = swap.value = '';
  welcome.hidden = false;
  workspace.hidden = nav.hidden = true;
  for (const panel of Object.values(panels)) panel.hidden = true;
  start.onchange = () => select(start.value);
  swap.onchange = () => select(swap.value);
}
