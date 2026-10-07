import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/vanilla/shallow';
import { ConversationPersistence } from './conversation-persistence.ts';
import type { ChatOperation, ChatTurn, Conversation, Corpus, SearchResult, ThinkingEffort } from './types.ts';
import { DEFAULT_THINKING_EFFORT, normalizeThinkingEffort } from './thinking-effort.ts';

export const CONVERSATION_LIMIT = 50;
const LEGACY_KEY = 'ragbox-search-history';
export interface NavigationSnapshot { selected: Corpus; active: Partial<Record<Corpus, string>>; thinkingEffort?: ThinkingEffort }
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
    answer: typeof turn.answer === 'string' ? turn.answer : '', thinking: typeof turn.thinking === 'string' ? turn.thinking : '', thinkingEffort: normalizeThinkingEffort(turn.thinkingEffort), includedIds: Array.isArray(turn.includedIds) ? turn.includedIds : [], citedIds: Array.isArray(turn.citedIds) ? turn.citedIds : [],
    phase: phases.has(turn.phase) ? turn.phase : 'stopped' as const,
    message: phases.has(turn.phase) ? turn.message : 'Interrupted by a page reload. Retry to continue.',
  }));
  return turns.length ? { ...value, turns } : undefined;
}

export interface ConversationSnapshot {
  items: Readonly<Record<string, Conversation>>;
  active: Partial<Record<Corpus, string>>;
  drafts: Readonly<Record<string, string>>;
  selected: Corpus;
  thinkingEffort: ThinkingEffort;
  initialized: boolean;
  unsaved: string;
  activeOperation?: ChatOperation;
  pendingTurn?: Pick<ChatOperation, 'conversationId' | 'turnId'>;
}

function emptyConversation(corpus: Corpus, time: number): Conversation {
  return { id: id('chat'), corpus, title: 'New chat', createdAt: time, updatedAt: time, turns: [] };
}
function recordValue<T>(record: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
export function createConversationState() {
  const initial = emptyConversation('nfcorpus', Date.now());
  return createStore(subscribeWithSelector<ConversationSnapshot>(() => ({
    items: { [initial.id]: initial }, active: { nfcorpus: initial.id }, drafts: {},
    selected: 'nfcorpus', thinkingEffort: DEFAULT_THINKING_EFFORT, initialized: false, unsaved: '',
  })));
}
export function currentConversation(state: ConversationSnapshot): Conversation {
  return recordValue(state.items, state.active[state.selected])!;
}
export function currentDraft(state: ConversationSnapshot) { return recordValue(state.drafts, currentConversation(state).id) ?? ''; }
export function savedConversations(state: ConversationSnapshot) {
  return Object.values(state.items).filter(item => item.turns.length).sort((a, b) => b.updatedAt - a.updatedAt);
}

export class ConversationStore {
  readonly state = createConversationState();
  private persistence: ConversationPersistence;
  private timestamp = 0;
  private initialization?: Promise<void>;
  constructor(private repository: ConversationRepository = new IndexedDBConversations(), private legacy = storage()) {
    this.persistence = new ConversationPersistence(repository, () => {
      this.state.setState({ unsaved: 'Could not save conversations. This chat is available in this page only.' });
    });
  }
  get selected() { return this.state.getState().selected; }
  get thinkingEffort() { return this.state.getState().thinkingEffort; }
  get initialized() { return this.state.getState().initialized; }
  get unsaved() { return this.state.getState().unsaved; }
  watch<T>(selector: (state: ConversationSnapshot) => T, listener: (value: T, previous: T) => void, fireImmediately = false) {
    return this.state.subscribe(selector, listener, { equalityFn: shallow, fireImmediately });
  }
  subscribe(listener: () => void) { return this.state.subscribe(listener); }
  private now() { this.timestamp = Math.max(Date.now(), this.timestamp + 1); return this.timestamp; }
  initialize() { return this.initialization ??= this.restore(); }
  private async restore() {
    const items: Record<string, Conversation> = Object.create(null);
    let selected: Corpus = 'nfcorpus';
    let active: Partial<Record<Corpus, string>> = {};
    let thinkingEffort = DEFAULT_THINKING_EFFORT;
    let unsaved = '';
    try {
      const loaded = await this.repository.load();
      thinkingEffort = normalizeThinkingEffort(loaded.navigation?.thinkingEffort);
      let legacy: Conversation[] = [];
      let legacyReadable = true;
      if (!loaded.imported) {
        try { legacy = importLegacyHistory(this.legacy?.getItem(LEGACY_KEY) ?? null); }
        catch { legacyReadable = false; unsaved = 'Old search history could not be imported. Saved conversations are still available.'; }
      }
      for (const candidate of [...legacy, ...loaded.conversations]) {
        const conversation = restoreConversation(candidate);
        if (conversation) items[conversation.id] = conversation;
      }
      if (loaded.navigation && isCorpus(loaded.navigation.selected)) {
        selected = loaded.navigation.selected;
        active = { ...loaded.navigation.active };
      }
      if (!loaded.imported && legacyReadable) await this.repository.import(legacy);
    } catch { unsaved = 'Conversation storage is unavailable. New chats will stay in this page only.'; }
    const retained = Object.values(items).sort((a, b) => b.updatedAt - a.updatedAt);
    const old = retained.slice(CONVERSATION_LIMIT).map(item => item.id);
    for (const conversationId of old) delete items[conversationId];
    this.persistence.remove(old);
    const existing = recordValue(items, active[selected]);
    if (!existing || existing.corpus !== selected) {
      const latest = retained.find(item => item.corpus === selected && items[item.id]);
      const current = latest ?? emptyConversation(selected, this.now());
      items[current.id] = current; active[selected] = current.id;
    }
    // Publish hydration atomically. Selectors never create a startup placeholder.
    this.state.setState({ items, active, selected, thinkingEffort, unsaved, initialized: true });
  }
  get(conversationId: string) { return recordValue(this.state.getState().items, conversationId); }
  conversations() { return savedConversations(this.state.getState()); }
  current() { return currentConversation(this.state.getState()); }
  draft() { return currentDraft(this.state.getState()); }
  setDraft(value: string) {
    const conversationId = this.current().id;
    this.state.setState(state => currentDraft(state) === value ? state : { drafts: { ...state.drafts, [conversationId]: value } });
  }
  setExecution(activeOperation?: ChatOperation) {
    this.state.setState(state => state.activeOperation === activeOperation ? state : { activeOperation });
  }
  setPending(pendingTurn?: ConversationSnapshot['pendingTurn']) {
    this.state.setState(state => state.pendingTurn === pendingTurn ? state : { pendingTurn });
  }
  private navigation() {
    const { selected, active, thinkingEffort } = this.state.getState();
    this.persistence.navigate({ selected, active: { ...active }, thinkingEffort });
  }
  select(corpus: Corpus) {
    const state = this.state.getState();
    if (state.selected === corpus) return;
    const existing = recordValue(state.items, state.active[corpus]);
    const current = existing?.corpus === corpus ? existing : this.conversations().find(item => item.corpus === corpus) ?? emptyConversation(corpus, this.now());
    this.state.setState({ selected: corpus, items: state.items[current.id] ? state.items : { ...state.items, [current.id]: current }, active: { ...state.active, [corpus]: current.id } });
    this.navigation();
  }
  setThinkingEffort(value: unknown) {
    const thinkingEffort = normalizeThinkingEffort(value);
    if (thinkingEffort === this.thinkingEffort) return;
    this.state.setState({ thinkingEffort }); this.navigation();
  }
  open(conversationId: string) {
    const conversation = this.get(conversationId);
    if (!conversation) return;
    this.state.setState(state => ({ selected: conversation.corpus, active: { ...state.active, [conversation.corpus]: conversationId } }));
    this.navigation();
  }
  newChat() {
    const state = this.state.getState();
    const previous = state.active[state.selected];
    const items = { ...state.items }; const drafts = { ...state.drafts };
    if (previous && !items[previous]?.turns.length) { delete items[previous]; delete drafts[previous]; }
    const conversation = emptyConversation(state.selected, this.now());
    this.state.setState({ items: { ...items, [conversation.id]: conversation }, drafts, active: { ...state.active, [state.selected]: conversation.id } });
    this.navigation(); return conversation;
  }
  append(question: string, history: ChatTurn['history'], contextLimited: boolean) {
    const state = this.state.getState(); const conversation = this.current();
    const turn: ChatTurn = { id: id('turn'), question, history, contextLimited, thinkingEffort: state.thinkingEffort, results: [], answer: '', includedIds: [], citedIds: [], phase: 'retrieving', stage: history.length ? 'resolve' : 'retrieve', message: 'Searching documents…' };
    const updated = { ...conversation, title: conversation.turns.length ? conversation.title : question, updatedAt: this.now(), turns: [...conversation.turns, turn] };
    const items = { ...state.items, [updated.id]: updated }; const drafts = { ...state.drafts, [updated.id]: '' };
    const old = Object.values(items).filter(item => item.turns.length).sort((a, b) => b.updatedAt - a.updatedAt).slice(CONVERSATION_LIMIT).map(item => item.id);
    for (const conversationId of old) { delete items[conversationId]; delete drafts[conversationId]; }
    this.persistence.save(updated); this.persistence.remove(old);
    this.state.setState({ items, drafts }); this.navigation(); return turn;
  }
  update(conversationId: string, turnId: string, changes: Partial<ChatTurn>, streaming = false) {
    const conversation = this.get(conversationId);
    const previous = conversation?.turns.find(turn => turn.id === turnId);
    if (!conversation || !previous || Object.entries(changes).every(([key, value]) => Object.is(previous[key as keyof ChatTurn], value))) return;
    const updated = { ...conversation, updatedAt: this.now(), turns: conversation.turns.map(turn => turn.id === turnId ? { ...turn, ...changes } : turn) };
    this.persistence.save(updated, streaming);
    this.state.setState(state => ({ items: { ...state.items, [conversationId]: updated } }));
  }
  flush() { return this.persistence.flush(); }
  async clear() {
    const conversation = emptyConversation(this.selected, this.now());
    try { this.legacy?.removeItem(LEGACY_KEY); } catch { /* Storage may be blocked. */ }
    this.persistence.clear();
    this.state.setState({ items: { [conversation.id]: conversation }, drafts: {}, active: { [conversation.corpus]: conversation.id }, activeOperation: undefined, pendingTurn: undefined });
    this.navigation(); await this.flush();
  }
}
export function createConversationStore(repository?: ConversationRepository, legacy?: Pick<Storage, 'getItem' | 'removeItem'>) {
  return new ConversationStore(repository, legacy);
}
