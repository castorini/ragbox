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
  answerStatus?: 'complete' | 'stopped';
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

  attachAnswer(id: string, answer: string, citedIds: string[], status: 'complete' | 'stopped' = 'complete') {
    const entry = this.items.find(item => item.id === id);
    if (!entry) return;
    entry.answer = answer;
    entry.citedIds = citedIds;
    entry.answerStatus = status;
    this.save();
  }

  clear() {
    this.items = [];
    try { this.storage?.removeItem(HISTORY_KEY); } catch { /* storage blocked */ }
    for (const listener of this.listeners) listener();
  }
}

// Every word of the filter must appear in the query, collection, answer, or a result title.
export function matchesHistory(entry: HistoryEntry, filter: string) {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [
    entry.query, corpusNames[entry.corpus] ?? entry.corpus, entry.answer ?? '',
    ...entry.results.map(result => result.title),
  ].join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}
