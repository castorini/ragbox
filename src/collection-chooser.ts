import { requiredElement } from './boundaries.ts';
import type { Corpus } from './types.ts';

type View = 'search' | 'history' | 'setup';
const setupSections = ['model', 'model-storage', 'model-management', 'setup-nfcorpus', 'setup-msmarco', 'collection-management', 'storage-management'];
// Sections whose guidance points at one button; focus it so Enter performs the next step.
const sectionActions: Record<string, string> = { '#model': '#llm-load' };

export function setupCollectionChooser(
  onCollectionChange: (value: Corpus) => void = () => {},
  onHome: () => void = () => {},
  chat = false,
) {
  const selector = requiredElement<HTMLSelectElement>('#collection-switch');
  const search = requiredElement<HTMLElement>('#search-view');
  const setup = requiredElement<HTMLElement>('#setup-view');
  const history = requiredElement<HTMLElement>('#history-view');
  const searchLink = requiredElement<HTMLAnchorElement>('#nav-search');
  const historyLink = requiredElement<HTMLAnchorElement>('#nav-history');
  const setupLink = requiredElement<HTMLAnchorElement>('#nav-setup');
  const skipLink = requiredElement<HTMLAnchorElement>('.skip-link');
  const panels = {
    nfcorpus: requiredElement<HTMLElement>('#nfcorpus-collection'),
    msmarco: requiredElement<HTMLElement>('#msmarco-collection'),
  };
  function selected(): Corpus { return selector.value === 'msmarco' ? 'msmarco' : 'nfcorpus'; }
  function composer(value = selected()) { return chat ? '#chat-query' : value === 'nfcorpus' ? '#fts-query' : '#marco-query'; }

  function select(value: Corpus, notify = true) {
    selector.value = value;
    panels.nfcorpus.hidden = value !== 'nfcorpus';
    panels.msmarco.hidden = value !== 'msmarco';
    if (currentView() === 'search') skipLink.href = composer(value);
    if (notify) onCollectionChange(value);
  }

  function currentView(): View {
    const view = new URL(window.location.href).searchParams.get('view');
    return view === 'setup' || view === 'history' ? view : 'search';
  }

  function showView(view: View, focus = false) {
    search.hidden = view !== 'search';
    history.hidden = view !== 'history';
    setup.hidden = view !== 'setup';
    for (const [name, link] of [['search', searchLink], ['history', historyLink], ['setup', setupLink]] as const) {
      if (name === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const label = view === 'setup' ? 'Settings' : view === 'history' ? 'History' : chat ? 'Chat' : 'Search';
    document.title = `${label} · ragbox`;
    const hash = new URL(window.location.href).hash;
    const sectionTarget = view === 'setup' && setupSections.includes(hash.slice(1))
      ? (hash === '#storage-management' ? '#collection-management' : hash) : undefined;
    const target = view === 'setup' ? (sectionTarget ?? '#setup-heading') : view === 'history'
      ? '#history-heading'
      : composer();
    skipLink.href = target;
    skipLink.textContent = `Skip to ${label.toLowerCase()}`;
    if (focus || sectionTarget) {
      const element = requiredElement<HTMLElement>(target);
      // Reveal management panels before scrolling or focusing a deep-link target.
      let ancestor: HTMLElement | null = element;
      while (ancestor) {
        if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
        ancestor = ancestor.parentElement;
      }
      const action = sectionTarget && sectionActions[sectionTarget]
        ? document.querySelector<HTMLButtonElement>(sectionActions[sectionTarget]) : null;
      element.scrollIntoView({ block: 'start' });
      if (action && !action.hidden && !action.disabled) action.focus({ preventScroll: true });
      else element.focus({ preventScroll: true });
    }
  }

  function navigate(view: View) {
    if (view === currentView()) {
      showView(view, true);
      return;
    }
    const url = new URL(window.location.href);
    if (view !== 'search') url.searchParams.set('view', view);
    else url.searchParams.delete('view');
    url.hash = '';
    window.history.pushState(null, '', url);
    showView(view, true);
    window.scrollTo({ top: 0 });
  }

  function openSetupSection(section: string) {
    navigate('setup');
    const url = new URL(window.location.href);
    url.hash = section;
    window.history.replaceState(null, '', url);
    showView('setup', true);
  }

  function goHome() {
    onHome();
    if (!chat) for (const prefix of ['fts', 'marco']) {
      requiredElement<HTMLElement>(`#${prefix}-results-area`).hidden = true;
      requiredElement<HTMLElement>(`#${prefix}-results`).textContent = '';
      requiredElement<HTMLElement>(`#${prefix}-answer`).textContent = '';
      const searchStatus = requiredElement<HTMLElement>(`#${prefix}-search-status`);
      searchStatus.hidden = true;
      searchStatus.textContent = '';
      requiredElement<HTMLInputElement>(`#${prefix}-query`).value = '';
    }
    navigate('search');
    window.scrollTo({ top: 0 });
  }

  requiredElement<HTMLAnchorElement>('#home-link').onclick = event => {
    event.preventDefault();
    goHome();
  };

  for (const [id, view] of [
    ['#nav-search', 'search'], ['#nav-history', 'history'], ['#nav-setup', 'setup'],
    ['#fts-setup-link', 'setup'], ['#marco-setup-link', 'setup'],
    ['#model-setup-link', 'setup'], ['#model-repair-link', 'setup'], ['#setup-back', 'search'],
    ['#model-storage-repair', 'setup'],
    ['#history-search-link', 'search'],
  ] as const) {
    requiredElement<HTMLAnchorElement>(id).onclick = event => {
      event.preventDefault();
      if (id === '#model-setup-link' || id === '#model-storage-repair') openSetupSection('model');
      else if (id === '#model-repair-link') openSetupSection('model-storage');
      else if (id === '#fts-setup-link') openSetupSection('setup-nfcorpus');
      else if (id === '#marco-setup-link') openSetupSection('setup-msmarco');
      else navigate(view);
    };
  }

  selector.onchange = () => {
    select(selected());
    if (!search.hidden) requiredElement<HTMLElement>(composer()).focus();
  };
  window.addEventListener('popstate', () => showView(currentView()));
  select('nfcorpus', false);
  showView(currentView());
  return {
    selected,
    choose(value: Corpus) {
      select(value);
      requiredElement<HTMLElement>(composer(value)).focus();
    },
    search(value: Corpus) {
      select(value);
      navigate('search');
    },
    openSetup(corpus: Corpus) { openSetupSection(`setup-${corpus}`); },
  };
}
