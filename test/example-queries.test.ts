import { it, expect, vi, afterEach } from 'vitest';
import { EXAMPLE_QUERIES, setupExampleQueries } from '../src/example-queries.ts';

type Key = { key: string; preventDefault: ReturnType<typeof vi.fn> };
type Fake = {
  id: string; value: string; disabled: boolean; hidden: boolean; textContent: string; className: string;
  children: Fake[]; attributes: Map<string, string>; ownerDocument: unknown;
  onclick?: () => void; onmousedown?: (event: { preventDefault(): void }) => void;
  onfocus?: () => void; oninput?: () => void; onblur?: () => void; onkeydown?: (event: Key) => void;
  focus: ReturnType<typeof vi.fn>; requestSubmit: ReturnType<typeof vi.fn>;
  classList: { toggle(name: string, on: boolean): void; has(name: string): boolean };
  setAttribute(name: string, value: string): void; removeAttribute(name: string): void;
  replaceChildren(...items: Fake[]): void;
};

function harness() {
  const elements = new Map<string, Fake>();
  const make = (id = ''): Fake => {
    const classes = new Set<string>();
    return {
      id, value: '', disabled: false, hidden: false, textContent: '', className: '', children: [],
      attributes: new Map(), ownerDocument: document, focus: vi.fn(), requestSubmit: vi.fn(),
      classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, has: name => classes.has(name) },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      replaceChildren(...items) { this.children = items; },
    };
  };
  const document = {
    createElement: () => make(),
    querySelector(id: string) {
      if (!elements.has(id)) elements.set(id, make(id.slice(1)));
      return elements.get(id);
    },
  };
  vi.stubGlobal('document', document);
  return (id: string) => document.querySelector(id)!;
}

const key = (name: string): Key => ({ key: name, preventDefault: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

it('lists the starter questions for each collection, closed until the search bar is focused', () => {
  const get = harness();
  setupExampleQueries();
  expect(get('#fts-examples').children.map(option => option.textContent)).toEqual(EXAMPLE_QUERIES.nfcorpus);
  expect(get('#marco-examples').children.map(option => option.textContent)).toEqual(EXAMPLE_QUERIES.msmarco);
  expect(get('#fts-examples').hidden).toBe(true);
  expect(get('#fts-query').attributes.get('role')).toBe('combobox');
});

it('opens on an empty search bar, hides while typing, and closes on blur', () => {
  const get = harness();
  setupExampleQueries();
  const input = get('#fts-query');
  input.onfocus?.();
  expect(get('#fts-examples').hidden).toBe(false);
  expect(get('#fts-form').classList.has('examples-open')).toBe(true);
  input.value = 'vit';
  input.oninput?.();
  expect(get('#fts-examples').hidden).toBe(true);
  input.value = '';
  input.oninput?.();
  expect(get('#fts-examples').hidden).toBe(false);
  input.onblur?.();
  expect(get('#fts-examples').hidden).toBe(true);
});

it('runs a clicked example when the collection is ready', () => {
  const get = harness();
  setupExampleQueries();
  get('#fts-query').onfocus?.();
  get('#fts-examples').children[1].onclick?.();
  expect(get('#fts-query').value).toBe(EXAMPLE_QUERIES.nfcorpus[1]);
  expect(get('#fts-form').requestSubmit).toHaveBeenCalled();
  expect(get('#fts-examples').hidden).toBe(true);
});

it('only fills the query while the collection is not ready', () => {
  const get = harness();
  get('#marco-search').disabled = true;
  setupExampleQueries();
  get('#marco-examples').children[2].onclick?.();
  expect(get('#marco-query').value).toBe(EXAMPLE_QUERIES.msmarco[2]);
  expect(get('#marco-form').requestSubmit).not.toHaveBeenCalled();
  expect(get('#marco-query').focus).toHaveBeenCalled();
});

it('supports arrow keys, Enter, and Escape', () => {
  const get = harness();
  setupExampleQueries();
  const input = get('#fts-query');
  input.onfocus?.();
  input.onkeydown?.(key('ArrowUp'));
  expect(input.attributes.get('aria-activedescendant')).toBe('fts-example-2');
  input.onkeydown?.(key('ArrowDown'));
  expect(input.attributes.get('aria-activedescendant')).toBe('fts-example-0');
  const enter = key('Enter');
  input.onkeydown?.(enter);
  expect(enter.preventDefault).toHaveBeenCalled();
  expect(input.value).toBe(EXAMPLE_QUERIES.nfcorpus[0]);

  input.value = '';
  input.onfocus?.();
  input.onkeydown?.(key('Escape'));
  expect(get('#fts-examples').hidden).toBe(true);
});
