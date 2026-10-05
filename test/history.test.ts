import { it, expect, vi } from 'vitest';
import { HISTORY_KEY, HISTORY_LIMIT, SearchHistory, matchesHistory, setupHistoryView } from '../src/history.ts';
import { FakeElements, fakeElement } from './fake-elements.ts';
import { citedIds } from '../src/llm-controller.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: (key: string) => { values.delete(key); },
  };
}

const result = (id: string) => ({ id, title: `Title ${id}`, text: `Text ${id}`, score: 1.5 });

it('starts empty and records searches newest first with their collection and results', () => {
  const storage = memoryStorage();
  const history = new SearchHistory(storage);
  expect(history.entries()).toEqual([]);
  history.record({ corpus: 'nfcorpus', query: 'vitamin d', results: [result('MED-1')] });
  history.record({ corpus: 'msmarco', query: 'capital of france', results: [] });
  expect(history.entries().map(entry => [entry.corpus, entry.query])).toEqual([
    ['msmarco', 'capital of france'], ['nfcorpus', 'vitamin d'],
  ]);
  expect(new SearchHistory(storage).entries()[1].results).toEqual([result('MED-1')]);
});

it('attaches the cited answer to its search and persists it', () => {
  const storage = memoryStorage();
  const history = new SearchHistory(storage);
  const listener = vi.fn();
  history.subscribe(listener);
  const entry = history.record({ corpus: 'nfcorpus', query: 'q', results: [result('MED-1'), result('MED-2')] });
  history.attachAnswer(entry.id, 'Yes [MED-2].', ['MED-2']);
  expect(listener).toHaveBeenCalledTimes(2);
  const saved = new SearchHistory(storage).entries()[0];
  expect(saved.answer).toBe('Yes [MED-2].');
  expect(saved.citedIds).toEqual(['MED-2']);
});

it('keeps only the most recent searches and clears on request', () => {
  const storage = memoryStorage();
  const history = new SearchHistory(storage);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) history.record({ corpus: 'nfcorpus', query: `q${i}`, results: [] });
  expect(history.entries()).toHaveLength(HISTORY_LIMIT);
  expect(history.entries()[0].query).toBe(`q${HISTORY_LIMIT + 4}`);
  history.clear();
  expect(history.entries()).toEqual([]);
  expect(storage.values.has(HISTORY_KEY)).toBe(false);
});

it('ignores corrupt saved data and still works when storage is full', () => {
  const storage = memoryStorage();
  storage.values.set(HISTORY_KEY, '{not json');
  expect(new SearchHistory(storage).entries()).toEqual([]);
  storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  const history = new SearchHistory(storage);
  history.record({ corpus: 'nfcorpus', query: 'q', results: [] });
  expect(history.entries()).toHaveLength(1);
  expect(new SearchHistory(undefined).entries()).toEqual([]);
});

it('lists only citations that refer to evidence given to the model, once each', () => {
  const targets = new Map([['MED-1', '#a'], ['MED-2', '#b']]);
  expect(citedIds('A [MED-2] and [MED-9], again [MED-2] then [MED-1].', targets)).toEqual(['MED-2', 'MED-1']);
});

it('persists a stopped answer and replaces it on retry within the same search', () => {
  const storage = memoryStorage();
  const history = new SearchHistory(storage);
  const entry = history.record({ corpus: 'nfcorpus', query: 'q', results: [result('MED-1')] });
  history.attachAnswer(entry.id, 'Partial [MED-1]', ['MED-1'], 'stopped');
  expect(new SearchHistory(storage).entries()[0]).toMatchObject({ answer: 'Partial [MED-1]', answerStatus: 'stopped' });
  history.attachAnswer(entry.id, 'Complete [MED-1].', ['MED-1']);
  expect(history.entries()).toHaveLength(1);
  expect(new SearchHistory(storage).entries()[0]).toMatchObject({ id: entry.id, answerStatus: 'complete', answer: 'Complete [MED-1].' });
});

it('renders stopped answers and treats older answers without a status as complete', () => {
  const storage = memoryStorage();
  storage.values.set(HISTORY_KEY, JSON.stringify([
    { id: 'old', time: 1, corpus: 'nfcorpus', query: 'old', results: [], answer: 'Old complete answer' },
    { id: 'stopped', time: 2, corpus: 'msmarco', query: 'new', results: [], answer: 'Partial', answerStatus: 'stopped' },
  ]));
  const nodes = new FakeElements();
  const doc = { querySelector: (selector: string) => nodes.get(selector), createElement: fakeElement };
  Object.assign(nodes.get('#history-list'), { ownerDocument: doc });
  vi.stubGlobal('document', doc);
  try {
    setupHistoryView(new SearchHistory(storage));
    const details = nodes.get('#history-list').children.map(item => item.children[0]);
    expect(details[0].children[1].children[0].textContent).toBe('Cited answer');
    expect(details[1].children[1].children[0].textContent).toBe('Cited answer · Stopped');
    expect(details[0].children[0].children[1].textContent).not.toContain('Stopped');
    expect(details[1].children[0].children[1].textContent).toContain('Stopped');
  } finally { vi.unstubAllGlobals(); }
});

it('filters history by query, collection, answer, and result titles, ignoring case and word order', () => {
  const entry = {
    id: 'h1', time: 0, corpus: 'nfcorpus' as const, query: 'Is coffee good for the heart?',
    results: [{ id: 'MED-7', title: 'Caffeine and arrhythmia', text: 'body text only', score: 1 }],
    answer: 'Moderate intake appears safe [MED-7].', citedIds: ['MED-7'],
  };
  expect(matchesHistory(entry, '')).toBe(true);
  expect(matchesHistory(entry, '  ')).toBe(true);
  expect(matchesHistory(entry, 'HEART coffee')).toBe(true);
  expect(matchesHistory(entry, 'nfcorpus')).toBe(true);
  expect(matchesHistory(entry, 'moderate')).toBe(true);
  expect(matchesHistory(entry, 'arrhythmia')).toBe(true);
  expect(matchesHistory(entry, 'coffee tea')).toBe(false);
  expect(matchesHistory(entry, 'body')).toBe(false);
  expect(matchesHistory(entry, 'ms marco')).toBe(false);
});

it('narrows the history list as the user types and reports when nothing matches', () => {
  const elements = new FakeElements();
  vi.stubGlobal('document', { querySelector: (id: string) => elements.get(id) });
  const history = new SearchHistory(undefined);
  history.record({ corpus: 'nfcorpus', query: 'vitamin d', results: [] });
  history.record({ corpus: 'msmarco', query: 'what causes thunder', results: [] });
  const list = elements.get('#history-list') as unknown as { ownerDocument: unknown };
  list.ownerDocument = {
    createElement: (tag: string) => Object.assign(fakeElement(tag), {
      className: '', open: false, setAttribute() {}, append(this: { children: unknown[] }, ...items: unknown[]) { this.children.push(...items); },
    }),
  };
  setupHistoryView(history);
  const filter = elements.get('#history-filter');
  const shown = () => elements.get('#history-list').children.filter(item => !item.hidden).length;
  expect(elements.get('#history-tools').hidden).toBe(false);
  expect(elements.get('#history-count').textContent).toBe('2 searches');
  filter.value = 'THUNDER';
  (filter as unknown as { oninput(): void }).oninput();
  expect(shown()).toBe(1);
  expect(elements.get('#history-count').textContent).toBe('1 of 2 searches');
  filter.value = 'zebra';
  (filter as unknown as { oninput(): void }).oninput();
  expect(shown()).toBe(0);
  expect(elements.get('#history-no-match').hidden).toBe(false);
  vi.unstubAllGlobals();
});
