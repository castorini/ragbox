import { requiredElement } from './boundaries.ts';
import { renderAnswer } from './llm-controller.ts';
import type { Corpus } from './types.ts';

export interface HistoryResult {
  id: string;
  title: string;
  text: string;
  score: number;
}

export interface HistoryEntry {
  id: string;
  time: number;
  corpus: Corpus;
  query: string;
  results: HistoryResult[];
  answer?: string;
  citedIds?: string[];
}

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const HISTORY_KEY = 'ragbox-search-history';
export const HISTORY_LIMIT = 50;
const corpusNames: Record<Corpus, string> = { nfcorpus: 'NFCorpus', msmarco: 'MS MARCO' };

function browserStorage(): HistoryStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

// Newest first. Storage can be blocked or full, so history degrades to this session only.
export class SearchHistory {
  private items: HistoryEntry[];
  private listeners = new Set<() => void>();
  private storage?: HistoryStorage;
  private counter = 0;

  constructor(storage: HistoryStorage | undefined = browserStorage()) {
    this.storage = storage;
    this.items = this.load();
  }

  private load(): HistoryEntry[] {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(HISTORY_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((entry): entry is HistoryEntry =>
        typeof entry?.id === 'string' && typeof entry.query === 'string' && Array.isArray(entry.results)) : [];
    } catch {
      return [];
    }
  }

  private save() {
    // Drop the oldest searches until the list fits the browser's storage quota.
    for (let keep = this.items.length; keep >= 0; keep--) {
      try {
        this.storage?.setItem(HISTORY_KEY, JSON.stringify(this.items.slice(0, keep)));
        break;
      } catch { /* quota exceeded or storage blocked */ }
    }
    for (const listener of this.listeners) listener();
  }

  entries(): readonly HistoryEntry[] { return this.items; }

  subscribe(listener: () => void) { this.listeners.add(listener); }

  record(search: Pick<HistoryEntry, 'corpus' | 'query' | 'results'>): HistoryEntry {
    const time = Date.now();
    const entry: HistoryEntry = { id: `h${time.toString(36)}${(++this.counter).toString(36)}`, time, ...search };
    this.items = [entry, ...this.items].slice(0, HISTORY_LIMIT);
    this.save();
    return entry;
  }

  attachAnswer(id: string, answer: string, citedIds: string[]) {
    const entry = this.items.find(item => item.id === id);
    if (!entry) return;
    entry.answer = answer;
    entry.citedIds = citedIds;
    this.save();
  }

  clear() {
    this.items = [];
    try { this.storage?.removeItem(HISTORY_KEY); } catch { /* storage blocked */ }
    for (const listener of this.listeners) listener();
  }
}

function resultItem(doc: Document, entry: HistoryEntry, result: HistoryResult, anchor: boolean) {
  const item = doc.createElement('li');
  if (anchor) {
    item.id = `${entry.id}-${encodeURIComponent(result.id)}`;
    item.tabIndex = -1;
  }
  const title = doc.createElement('h4');
  title.textContent = result.title;
  const metadata = doc.createElement('p');
  metadata.className = 'history-result-meta';
  metadata.textContent = `${result.id} · BM25 ${Number(result.score).toFixed(4)}`;
  const excerpt = doc.createElement('p');
  excerpt.textContent = result.text.slice(0, 350) + (result.text.length > 350 ? '…' : '');
  item.append(title, metadata, excerpt);
  return item;
}

function entryElement(doc: Document, entry: HistoryEntry) {
  const item = doc.createElement('li');
  item.className = 'history-entry';
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  const query = doc.createElement('span');
  query.className = 'history-query';
  query.textContent = entry.query;
  const cited = entry.citedIds ?? [];
  const meta = doc.createElement('span');
  meta.className = 'history-meta';
  meta.textContent = [
    corpusNames[entry.corpus] ?? entry.corpus,
    new Date(entry.time).toLocaleString(),
    `${entry.results.length} ${entry.results.length === 1 ? 'result' : 'results'}`,
    entry.answer ? `${cited.length} cited` : 'No answer',
  ].join(' · ');
  summary.append(query, meta);
  details.append(summary);

  if (entry.answer) {
    const panel = doc.createElement('div');
    panel.className = 'llm-answer-panel';
    const heading = doc.createElement('h3');
    heading.textContent = 'Cited answer';
    const answer = doc.createElement('p');
    answer.className = 'llm-answer';
    renderAnswer(answer, entry.answer, new Map(cited.map(id => [id, `#${entry.id}-${encodeURIComponent(id)}`])));
    panel.append(heading, answer);
    details.append(panel);
  }
  const citedResults = entry.results.filter(result => cited.includes(result.id));
  if (citedResults.length) {
    const heading = doc.createElement('h3');
    heading.textContent = 'Cited results';
    const list = doc.createElement('ol');
    list.append(...citedResults.map(result => resultItem(doc, entry, result, true)));
    details.append(heading, list);
  }
  if (entry.results.length) {
    const all = doc.createElement('details');
    all.className = 'history-all-results';
    all.open = !citedResults.length;
    const label = doc.createElement('summary');
    label.textContent = `All results (${entry.results.length})`;
    const list = doc.createElement('ol');
    list.append(...entry.results.map(result => resultItem(doc, entry, result, false)));
    all.append(label, list);
    details.append(all);
  } else {
    const none = doc.createElement('p');
    none.className = 'history-no-results';
    none.textContent = 'This search returned no results.';
    details.append(none);
  }
  item.append(details);
  return item;
}

export function setupHistoryView(history: SearchHistory) {
  const list = requiredElement<HTMLOListElement>('#history-list');
  const empty = requiredElement<HTMLElement>('#history-empty');
  const clear = requiredElement<HTMLButtonElement>('#history-clear');
  function render() {
    const entries = history.entries();
    empty.hidden = entries.length > 0;
    clear.hidden = entries.length === 0;
    list.replaceChildren(...entries.map(entry => entryElement(list.ownerDocument, entry)));
  }
  clear.onclick = () => {
    if (confirm('Clear all search history in this browser?')) history.clear();
  };
  history.subscribe(render);
  render();
  return { render };
}
