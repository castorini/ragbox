import type { ChatTurn, Conversation, Corpus, SearchResult } from './types.ts';

export const CONVERSATION_LIMIT = 50;
const LEGACY_KEY = 'ragbox-search-history';
export interface NavigationSnapshot { selected: Corpus; active: Partial<Record<Corpus, string>> }
export interface ConversationRepository {
  load(): Promise<{ conversations: Conversation[]; navigation?: NavigationSnapshot; imported: boolean }>;
  save(conversation: Conversation): Promise<void>;
  remove(ids: string[]): Promise<void>;
  navigate(navigation: NavigationSnapshot): Promise<void>;
  import(conversations: Conversation[]): Promise<void>;
  clear(): Promise<void>;
}

export class IndexedDBConversations implements ConversationRepository {
  private database?: Promise<IDBDatabase>;
  constructor(private factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private open() {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new Error('IndexedDB is unavailable.')); return; }
      const request = this.factory.open('ragbox-conversations', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('conversations', { keyPath: 'id' });
        request.result.createObjectStore('meta');
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other RAGbox tabs to open conversation storage.'));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
    });
    return this.database;
  }
  private async write(operation: (tx: IDBTransaction) => void) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['conversations', 'meta'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Conversation storage failed.'));
      operation(tx);
    });
  }
  async load() {
    const db = await this.open();
    return new Promise<{ conversations: Conversation[]; navigation?: NavigationSnapshot; imported: boolean }>((resolve, reject) => {
      const tx = db.transaction(['conversations', 'meta'], 'readonly');
      const conversations = tx.objectStore('conversations').getAll();
      const navigation = tx.objectStore('meta').get('navigation');
      const imported = tx.objectStore('meta').get('imported');
      tx.oncomplete = () => resolve({ conversations: conversations.result as Conversation[], navigation: navigation.result as NavigationSnapshot | undefined, imported: imported.result === true });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  save(conversation: Conversation) { return this.write(tx => { tx.objectStore('conversations').put(conversation); }); }
  remove(ids: string[]) { return this.write(tx => { for (const id of ids) tx.objectStore('conversations').delete(id); }); }
  navigate(navigation: NavigationSnapshot) { return this.write(tx => { tx.objectStore('meta').put(navigation, 'navigation'); }); }
  import(conversations: Conversation[]) {
    return this.write(tx => {
      for (const conversation of conversations) tx.objectStore('conversations').put(conversation);
      tx.objectStore('meta').put(true, 'imported');
    });
  }
  clear() { return this.write(tx => { tx.objectStore('conversations').clear(); tx.objectStore('meta').put(true, 'imported'); }); }
}

function storage(): Pick<Storage, 'getItem' | 'removeItem'> | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function id(prefix: string) { return `${prefix}-${globalThis.crypto.randomUUID()}`; }
function isCorpus(value: unknown): value is Corpus { return value === 'nfcorpus' || value === 'msmarco'; }
function validResults(value: unknown): value is SearchResult[] {
  return Array.isArray(value) && value.every(row => row && typeof row.id === 'string' && typeof row.title === 'string' && typeof row.text === 'string' && typeof row.score === 'number');
}

export function importLegacyHistory(raw: string | null): Conversation[] {
  let entries: unknown;
  try { entries = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.query !== 'string' || !isCorpus(entry.corpus) || !validResults(entry.results)) return [];
    const time = typeof entry.time === 'number' ? entry.time : Date.now();
    const answer = typeof entry.answer === 'string' ? entry.answer : '';
    const ids = new Set(entry.results.map((row: SearchResult) => row.id));
    const citedIds = (Array.isArray(entry.citedIds) ? entry.citedIds : []).filter((value: unknown): value is string => typeof value === 'string' && ids.has(value));
    return [{ id: `legacy-${entry.id}`, corpus: entry.corpus, title: entry.query, createdAt: time, updatedAt: time,
      turns: [{ id: `legacy-turn-${entry.id}`, question: entry.query, searchQuery: entry.query, results: entry.results, answer, includedIds: citedIds,
        citedIds, phase: entry.answerStatus === 'stopped' ? 'stopped' : answer ? 'complete' : 'blocked', stage: 'generate', message: answer ? '' : 'Saved search. Retry to generate an answer.', history: [] }],
    } satisfies Conversation];
  }).slice(0, CONVERSATION_LIMIT);
}

function restoreConversation(value: Conversation): Conversation | undefined {
  if (!value || typeof value.id !== 'string' || !isCorpus(value.corpus) || typeof value.title !== 'string' || !Array.isArray(value.turns)) return;
  const phases = new Set(['complete', 'stopped', 'error', 'blocked']);
  const turns = value.turns.filter(turn => turn && typeof turn.id === 'string' && typeof turn.question === 'string' && validResults(turn.results)).map(turn => ({
    ...turn, history: Array.isArray(turn.history) ? turn.history.filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') : [],
    answer: typeof turn.answer === 'string' ? turn.answer : '', thinking: typeof turn.thinking === 'string' ? turn.thinking : '', includedIds: Array.isArray(turn.includedIds) ? turn.includedIds : [], citedIds: Array.isArray(turn.citedIds) ? turn.citedIds : [],
    phase: phases.has(turn.phase) ? turn.phase : 'stopped' as const,
    message: phases.has(turn.phase) ? turn.message : 'Interrupted by a page reload. Retry to continue.',
  }));
  return turns.length ? { ...value, turns } : undefined;
}

export class ConversationStore {
  private items = new Map<string, Conversation>();
  private listeners = new Set<() => void>();
  private active: Partial<Record<Corpus, string>> = {};
  private drafts = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private checkpoints = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Conversation>();
  private timestamp = 0;
  selected: Corpus = 'nfcorpus';
  initialized = false;
  unsaved = '';
  constructor(private repository: ConversationRepository = new IndexedDBConversations(), private legacy = storage()) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) listener(); }
  private now() { this.timestamp = Math.max(Date.now(), this.timestamp + 1); return this.timestamp; }
  private write(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch(() => { this.unsaved = 'Could not save conversations. This chat is available in this page only.'; this.notify(); });
  }
  async initialize() {
    try {
      const loaded = await this.repository.load();
      let legacy: Conversation[] = [];
      let legacyReadable = true;
      if (!loaded.imported) {
        try { legacy = importLegacyHistory(this.legacy?.getItem(LEGACY_KEY) ?? null); }
        catch { legacyReadable = false; this.unsaved = 'Old search history could not be imported. Saved conversations are still available.'; }
      }
      for (const candidate of [...legacy, ...loaded.conversations]) {
        const conversation = restoreConversation(candidate);
        if (conversation) this.items.set(conversation.id, conversation);
      }
      this.active = {};
      // The marker and imported chats commit together; interrupted imports are safe to retry.
      if (loaded.navigation && isCorpus(loaded.navigation.selected)) {
        this.selected = loaded.navigation.selected;
        this.active = loaded.navigation.active ?? {};
      }
      if (!loaded.imported && legacyReadable) await this.repository.import(legacy);
      this.retain();
    } catch { this.unsaved = 'Conversation storage is unavailable. New chats will stay in this page only.'; }
    this.initialized = true;
    this.current();
    this.notify();
  }
  get(conversationId: string) { return this.items.get(conversationId); }
  conversations() { return [...this.items.values()].filter(item => item.turns.length).sort((a, b) => b.updatedAt - a.updatedAt); }
  current(): Conversation {
    const existing = this.active[this.selected];
    if (existing && this.items.get(existing)?.corpus === this.selected) return this.items.get(existing)!;
    const latest = this.conversations().find(item => item.corpus === this.selected);
    if (latest) { this.active[this.selected] = latest.id; return latest; }
    return this.newChat(false);
  }
  draft() { return this.drafts.get(this.current().id) ?? ''; }
  setDraft(value: string) { this.drafts.set(this.current().id, value); }
  private navigation() {
    const snapshot: NavigationSnapshot = { selected: this.selected, active: { ...this.active } };
    this.write(() => this.repository.navigate(snapshot));
  }
  select(corpus: Corpus) { this.selected = corpus; this.current(); this.navigation(); this.notify(); }
  open(conversationId: string) {
    const conversation = this.items.get(conversationId);
    if (!conversation) return;
    this.selected = conversation.corpus;
    this.active[this.selected] = conversationId;
    this.navigation(); this.notify();
  }
  newChat(notify = true) {
    const previous = this.active[this.selected];
    if (previous && !this.items.get(previous)?.turns.length) { this.items.delete(previous); this.drafts.delete(previous); }
    const time = this.now();
    const conversation: Conversation = { id: id('chat'), corpus: this.selected, title: 'New chat', createdAt: time, updatedAt: time, turns: [] };
    this.items.set(conversation.id, conversation); this.active[this.selected] = conversation.id;
    if (notify) { this.navigation(); this.notify(); }
    return conversation;
  }
  append(question: string, history: ChatTurn['history'], contextLimited: boolean) {
    const conversation = this.current();
    const turn: ChatTurn = { id: id('turn'), question, history, contextLimited, results: [], answer: '', includedIds: [], citedIds: [], phase: 'retrieving', stage: history.length ? 'resolve' : 'retrieve', message: 'Searching documents…' };
    const updated = { ...conversation, title: conversation.turns.length ? conversation.title : question, updatedAt: this.now(), turns: [...conversation.turns, turn] };
    this.items.set(updated.id, updated); this.drafts.set(updated.id, ''); this.persist(updated); this.retain(); this.navigation(); this.notify();
    return turn;
  }
  update(conversationId: string, turnId: string, changes: Partial<ChatTurn>, streaming = false) {
    const conversation = this.items.get(conversationId);
    if (!conversation) return;
    const updated = { ...conversation, updatedAt: this.now(), turns: conversation.turns.map(turn => turn.id === turnId ? { ...turn, ...changes } : turn) };
    this.items.set(conversationId, updated); this.persist(updated, streaming); this.notify();
  }
  private persist(conversation: Conversation, streaming = false) {
    if (streaming) {
      this.pending.set(conversation.id, conversation);
      if (!this.checkpoints.has(conversation.id)) this.checkpoints.set(conversation.id, setTimeout(() => this.checkpoint(conversation.id), 1000));
      return;
    }
    clearTimeout(this.checkpoints.get(conversation.id)); this.checkpoints.delete(conversation.id); this.pending.delete(conversation.id);
    this.write(() => this.repository.save(conversation));
  }
  private checkpoint(conversationId: string) {
    const conversation = this.pending.get(conversationId);
    if (conversation) this.persist(conversation);
  }
  private retain() {
    const old = this.conversations().slice(CONVERSATION_LIMIT).map(item => item.id);
    for (const conversationId of old) {
      this.items.delete(conversationId); this.drafts.delete(conversationId);
      clearTimeout(this.checkpoints.get(conversationId)); this.checkpoints.delete(conversationId); this.pending.delete(conversationId);
    }
    if (old.length) this.write(() => this.repository.remove(old));
  }
  async flush() { for (const conversationId of this.pending.keys()) this.checkpoint(conversationId); await this.queue; }
  async clear() {
    for (const timer of this.checkpoints.values()) clearTimeout(timer);
    this.checkpoints.clear(); this.pending.clear(); this.items.clear(); this.drafts.clear(); this.active = {};
    try { this.legacy?.removeItem(LEGACY_KEY); } catch { /* Storage may be blocked. */ }
    this.write(() => this.repository.clear()); this.newChat(); await this.queue;
  }
}
