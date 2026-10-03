import { it, expect, vi, afterEach } from 'vitest';
import { setupCollectionChooser } from '../src/collection-chooser.ts';

type FakeElement = {
  hidden: boolean;
  value: string;
  textContent: string;
  onclick?: (event: { preventDefault(): void }) => void;
  onchange?: () => void;
  scrollIntoView: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
};

function harness(start = 'https://example.com/ragbox/') {
  let href = start;
  let popstate = () => {};
  const elements = new Map<string, FakeElement>();
  const document = {
    title: '',
    querySelector(id: string) {
      if (!elements.has(id)) elements.set(id, {
        hidden: false, value: '', textContent: '', focus: vi.fn(), scrollIntoView: vi.fn(),
        setAttribute: vi.fn(), removeAttribute: vi.fn(),
      });
      return elements.get(id);
    },
  };
  const window = {
    location: { get href() { return href; } },
    history: { pushState(_state: unknown, _title: string, url: URL) { href = url.href; }, replaceState(_state: unknown, _title: string, url: URL) { href = url.href; } },
    addEventListener(_type: string, listener: () => void) { popstate = listener; },
    scrollTo: vi.fn(),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  return {
    get: (id: string) => document.querySelector(id)!,
    get href() { return href; },
    setHref(value: string) { href = value; popstate(); },
    click(id: string) { document.querySelector(id)!.onclick?.({ preventDefault() {} }); },
  };
}

afterEach(() => vi.unstubAllGlobals());

it('opens NFCorpus search directly and keeps each query and result panel when switching', () => {
  const ui = harness();
  const changed = vi.fn();
  const chooser = setupCollectionChooser(changed);
  expect(chooser.selected()).toBe('nfcorpus');
  expect(ui.get('#search-view').hidden).toBe(false);
  expect(ui.get('#setup-view').hidden).toBe(true);
  expect(ui.get('#nfcorpus-collection').hidden).toBe(false);

  ui.get('#fts-query').value = 'nutrition';
  ui.get('#collection-switch').value = 'msmarco';
  ui.get('#collection-switch').onchange?.();
  expect(changed).toHaveBeenCalledWith('msmarco');
  expect(ui.get('#nfcorpus-collection').hidden).toBe(true);
  expect(ui.get('#msmarco-collection').hidden).toBe(false);
  expect(ui.get('#fts-query').value).toBe('nutrition');
  expect(ui.get('#marco-query').focus).toHaveBeenCalled();
});

it('opens direct Setup links and supports in-page navigation and Back/Forward', () => {
  const ui = harness('https://example.com/ragbox/?view=setup');
  setupCollectionChooser();
  expect(ui.get('#setup-view').hidden).toBe(false);
  expect(ui.get('#search-view').hidden).toBe(true);

  ui.click('#setup-back');
  expect(ui.href).toBe('https://example.com/ragbox/');
  expect(ui.get('#search-view').hidden).toBe(false);
  ui.click('#fts-setup-link');
  expect(ui.href).toBe('https://example.com/ragbox/?view=setup');
  expect(ui.get('#setup-view').hidden).toBe(false);

  ui.setHref('https://example.com/ragbox/#fts-result-1');
  expect(ui.get('#search-view').hidden).toBe(false);
  ui.setHref('https://example.com/ragbox/?view=setup');
  expect(ui.get('#setup-view').hidden).toBe(false);
});

it('opens the active collection results from Settings without losing the query', () => {
  const ui = harness();
  setupCollectionChooser();
  ui.get('#collection-switch').value = 'msmarco';
  ui.get('#collection-switch').onchange?.();
  ui.get('#marco-query').value = 'example query';
  ui.click('#nav-setup');
  ui.click('#nav-results');
  expect(ui.href).toContain('view=results');
  expect(ui.get('#search-view').hidden).toBe(false);
  expect(ui.get('#setup-view').hidden).toBe(true);
  expect(ui.get('#marco-results-area').scrollIntoView).toHaveBeenCalled();
  expect(ui.get('#marco-query').value).toBe('example query');
  expect(ui.get('#nav-results').setAttribute).toHaveBeenCalledWith('aria-current', 'page');
});

it('opens the model settings from the load shortcut and focuses the load button', () => {
  const ui = harness();
  setupCollectionChooser();
  ui.click('#model-setup-link');
  expect(ui.href).toBe('https://example.com/ragbox/?view=setup#model');
  expect(ui.get('#setup-view').hidden).toBe(false);
  expect(ui.get('#model').scrollIntoView).toHaveBeenCalled();
  expect(ui.get('#llm-load').focus).toHaveBeenCalled();
  expect(ui.get('#model').focus).not.toHaveBeenCalled();
});

it('focuses the model section instead when the load button is unavailable', () => {
  const ui = harness();
  setupCollectionChooser();
  ui.get('#llm-load').hidden = true;
  ui.click('#model-setup-link');
  expect(ui.get('#model').focus).toHaveBeenCalled();
  expect(ui.get('#llm-load').focus).not.toHaveBeenCalled();
});

it('returns to the starting search page from the logo, clearing results and stopping generation', () => {
  const ui = harness('https://example.com/ragbox/?view=results');
  const onHome = vi.fn();
  setupCollectionChooser(undefined, onHome);
  for (const prefix of ['fts', 'marco']) {
    ui.get(`#${prefix}-results-area`).hidden = false;
    ui.get(`#${prefix}-results`).textContent = 'result';
    ui.get(`#${prefix}-answer`).textContent = 'answer';
    ui.get(`#${prefix}-search-status`).hidden = false;
    ui.get(`#${prefix}-query`).value = 'breast cancer';
  }

  ui.click('#home-link');
  expect(onHome).toHaveBeenCalledOnce();
  expect(ui.href).toBe('https://example.com/ragbox/');
  for (const prefix of ['fts', 'marco']) {
    expect(ui.get(`#${prefix}-results-area`).hidden).toBe(true);
    expect(ui.get(`#${prefix}-results`).textContent).toBe('');
    expect(ui.get(`#${prefix}-answer`).textContent).toBe('');
    expect(ui.get(`#${prefix}-search-status`).hidden).toBe(true);
    expect(ui.get(`#${prefix}-query`).value).toBe('');
  }
  expect(ui.get('#fts-query').focus).toHaveBeenCalled();
});
