import { requiredElement } from './boundaries.ts';
import type { Corpus } from './types.ts';

type View = 'search' | 'setup';

export function setupCollectionChooser(onCollectionChange: (value: Corpus) => void = () => {}) {
  const selector = requiredElement<HTMLSelectElement>('#collection-switch');
  const description = requiredElement<HTMLElement>('#collection-description');
  const search = requiredElement<HTMLElement>('#search-view');
  const setup = requiredElement<HTMLElement>('#setup-view');
  const searchLink = requiredElement<HTMLAnchorElement>('#nav-search');
  const setupLink = requiredElement<HTMLAnchorElement>('#nav-setup');
  const skipLink = requiredElement<HTMLAnchorElement>('.skip-link');
  const panels = {
    nfcorpus: requiredElement<HTMLElement>('#nfcorpus-collection'),
    msmarco: requiredElement<HTMLElement>('#msmarco-collection'),
  };
  const descriptions: Record<Corpus, string> = {
    nfcorpus: '3,633 health and nutrition research documents',
    msmarco: '8.8 million web passages',
  };

  function selected(): Corpus { return selector.value === 'msmarco' ? 'msmarco' : 'nfcorpus'; }

  function select(value: Corpus, notify = true) {
    selector.value = value;
    panels.nfcorpus.hidden = value !== 'nfcorpus';
    panels.msmarco.hidden = value !== 'msmarco';
    description.textContent = descriptions[value];
    if (notify) onCollectionChange(value);
  }

  function currentView(): View {
    return new URL(window.location.href).searchParams.get('view') === 'setup' ? 'setup' : 'search';
  }

  function showView(view: View, focus = false) {
    search.hidden = view !== 'search';
    setup.hidden = view !== 'setup';
    if (view === 'search') {
      searchLink.setAttribute('aria-current', 'page');
      setupLink.removeAttribute('aria-current');
    } else {
      setupLink.setAttribute('aria-current', 'page');
      searchLink.removeAttribute('aria-current');
    }
    document.title = `${view === 'search' ? 'Search' : 'Setup'} · ragbox`;
    skipLink.href = view === 'search' ? '#search-heading' : '#setup-heading';
    skipLink.textContent = view === 'search' ? 'Skip to search' : 'Skip to setup';
    if (focus) requiredElement<HTMLElement>(view === 'search' ? '#search-heading' : '#setup-heading').focus();
  }

  function navigate(view: View) {
    if (view === currentView()) {
      showView(view, true);
      return;
    }
    const url = new URL(window.location.href);
    if (view === 'setup') url.searchParams.set('view', 'setup');
    else url.searchParams.delete('view');
    url.hash = '';
    window.history.pushState(null, '', url);
    showView(view, true);
    window.scrollTo({ top: 0 });
  }

  for (const [id, view] of [
    ['#nav-search', 'search'], ['#nav-setup', 'setup'],
    ['#fts-setup-link', 'setup'], ['#marco-setup-link', 'setup'],
    ['#model-setup-link', 'setup'], ['#setup-back', 'search'],
  ] as const) {
    requiredElement<HTMLAnchorElement>(id).onclick = event => {
      event.preventDefault();
      navigate(view);
    };
  }

  selector.onchange = () => {
    select(selected());
    if (!search.hidden) requiredElement<HTMLInputElement>(selected() === 'nfcorpus' ? '#fts-query' : '#marco-query').focus();
  };
  window.addEventListener('popstate', () => showView(currentView()));
  select('nfcorpus', false);
  showView(currentView());
  return { selected };
}
