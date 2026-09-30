import { it, expect, vi, afterEach } from 'vitest';
import { setupCollectionChooser } from '../src/collection-chooser.ts';

type FakeElement = {
  hidden: boolean;
  value: string;
  textContent: string;
  onclick?: (event: { preventDefault(): void }) => void;
  onchange?: () => void;
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
        hidden: false, value: '', textContent: '', focus: vi.fn(),
        setAttribute: vi.fn(), removeAttribute: vi.fn(),
      });
      return elements.get(id);
    },
  };
  const window = {
    location: { get href() { return href; } },
    history: { pushState(_state: unknown, _title: string, url: URL) { href = url.href; } },
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
  expect(ui.get('#collection-description').textContent).toContain('3,633');

  ui.get('#fts-query').value = 'nutrition';
  ui.get('#collection-switch').value = 'msmarco';
  ui.get('#collection-switch').onchange?.();
  expect(changed).toHaveBeenCalledWith('msmarco');
  expect(ui.get('#nfcorpus-collection').hidden).toBe(true);
  expect(ui.get('#msmarco-collection').hidden).toBe(false);
  expect(ui.get('#collection-description').textContent).toContain('8.8 million');
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
