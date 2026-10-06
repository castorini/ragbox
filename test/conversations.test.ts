import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore, importLegacyHistory, CONVERSATION_LIMIT } from '../src/conversations.ts';
import { deferred, memoryRepository } from './conversation-fixtures.ts';
import { matchesConversation, sourceAnchor, handleComposerKey } from '../src/chat-view.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const legacy = { id: 'h1', time: 1, corpus: 'nfcorpus', query: 'coffee', results: [{ id: 'MED-1', title: 'Sleep evidence', text: 'Text', score: 2 }], answer: 'Finding [MED-1].', citedIds: ['MED-1'], answerStatus: 'stopped' };

describe('conversation persistence', () => {
  it('saves the effort preference and captures it independently for each submitted turn', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    expect(store.thinkingEffort).toBe('balanced');
    store.setThinkingEffort('high'); const first = store.append('q1', [], false);
    store.setThinkingEffort('low'); store.append('q2', [], false); await store.flush();
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.thinkingEffort).toBe('low');
    expect(restored.current().turns.map(turn => turn.thinkingEffort)).toEqual(['high', 'low']);
    expect(first.thinkingEffort).toBe('high');
    store.setThinkingEffort('invalid'); expect(store.thinkingEffort).toBe('balanced');
  });
  it('defaults older and malformed saved effort preferences and turns to Balanced', async () => {
    const older = importLegacyHistory(JSON.stringify([legacy]))[0];
    older.turns[0].thinkingEffort = 'unbounded' as never;
    const repository = memoryRepository([older]);
    vi.mocked(repository.load).mockResolvedValueOnce({ conversations: [older], imported: true, navigation: { selected: 'nfcorpus', active: {}, thinkingEffort: 'unbounded' as never } });
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.thinkingEffort).toBe('balanced'); expect(restored.current().turns[0].thinkingEffort).toBe('balanced');
  });
  it('imports legacy searches with deterministic IDs, stopped answers, and document snapshots', () => {
    const imported = importLegacyHistory(JSON.stringify([legacy, { bad: true }]));
    expect(imported).toHaveLength(1); expect(imported[0]).toMatchObject({ id: 'legacy-h1', createdAt: 1, turns: [{ phase: 'stopped', includedIds: ['MED-1'], results: legacy.results }] });
    expect(importLegacyHistory('broken')).toEqual([]);
  });
  it('records an import marker once while keeping the old storage intact', async () => {
    const repository = memoryRepository(); vi.mocked(repository.load).mockResolvedValueOnce({ conversations: [], imported: false });
    const storage = { getItem: vi.fn(() => JSON.stringify([legacy])), removeItem: vi.fn() };
    const store = new ConversationStore(repository, storage); await store.initialize();
    expect(repository.import).toHaveBeenCalledOnce(); expect(store.conversations()).toHaveLength(1); expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it('restores the latest legacy chat even when the view created a startup placeholder', async () => {
    const repository = memoryRepository(); vi.mocked(repository.load).mockResolvedValueOnce({ conversations: [], imported: false });
    const store = new ConversationStore(repository, { getItem: () => JSON.stringify([legacy]), removeItem: vi.fn() });
    store.current(); await store.initialize(); expect(store.current().id).toBe('legacy-h1');
  });
  it('keeps imported chats and restored selection in memory when migration storage fails', async () => {
    const repository = memoryRepository(); vi.mocked(repository.load).mockResolvedValueOnce({ conversations: [], imported: false, navigation: { selected: 'msmarco', active: {} } });
    vi.mocked(repository.import).mockRejectedValueOnce(new Error('Storage failed'));
    const store = new ConversationStore(repository, { getItem: () => JSON.stringify([legacy]), removeItem: vi.fn() }); await store.initialize();
    expect(store.conversations()[0].id).toBe('legacy-h1'); expect(store.selected).toBe('msmarco'); expect(store.unsaved).toContain('unavailable');
  });
  it('restores IndexedDB chats when legacy storage is blocked and leaves migration retryable', async () => {
    const repository = memoryRepository(); vi.mocked(repository.load).mockResolvedValueOnce({ conversations: importLegacyHistory(JSON.stringify([legacy])), imported: false });
    const store = new ConversationStore(repository, { getItem: () => { throw new Error('Access denied'); }, removeItem: vi.fn() }); await store.initialize();
    expect(store.current().id).toBe('legacy-h1'); expect(repository.import).not.toHaveBeenCalled(); expect(store.unsaved).toContain('could not be imported');
  });
  it('restores interrupted turns as stopped and keeps the transcript and selection', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize(); store.select('msmarco');
    const turn = store.append('thunder', [], false); store.update(store.current().id, turn.id, { phase: 'generating', answer: 'Partial' }); await store.flush();
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.selected).toBe('msmarco'); expect(restored.current().turns[0]).toMatchObject({ phase: 'stopped', answer: 'Partial', message: expect.stringContaining('page reload') });
  });
  it('roundtrips folded reasoning separately from completed answers and citation metadata', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const turn = store.append('coffee', [], false);
    store.update(store.current().id, turn.id, { phase: 'complete', thinking: 'Comparison [MED-1] and unsupported [MED-404].', answer: 'Final finding [MED-2].', includedIds: ['MED-1', 'MED-2'], citedIds: ['MED-2'] });
    await store.flush();
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.current().turns[0]).toMatchObject({ phase: 'complete', thinking: 'Comparison [MED-1] and unsupported [MED-404].', answer: 'Final finding [MED-2].', includedIds: ['MED-1', 'MED-2'], citedIds: ['MED-2'] });
  });
  it('restores a page interrupted during reasoning as stopped without treating reasoning as an answer', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const turn = store.append('coffee', [], false);
    store.update(store.current().id, turn.id, { phase: 'generating', thinking: 'Unfinished comparison [MED-1].', answer: '', includedIds: ['MED-1'], citedIds: [] });
    await store.flush();
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.current().turns[0]).toMatchObject({ phase: 'stopped', thinking: 'Unfinished comparison [MED-1].', answer: '', citedIds: [], message: expect.stringContaining('page reload') });
  });
  it('loads older saved conversations without reasoning and normalizes invalid reasoning values', async () => {
    const older = importLegacyHistory(JSON.stringify([legacy]))[0];
    expect(older.turns[0].thinking).toBeUndefined();
    const restored = new ConversationStore(memoryRepository([older])); await restored.initialize();
    expect(restored.current().turns[0].thinking).toBe('');
    const malformed = structuredClone(older);
    malformed.turns[0].thinking = 42 as unknown as string;
    const normalized = new ConversationStore(memoryRepository([malformed])); await normalized.initialize();
    expect(normalized.current().turns[0].thinking).toBe('');
  });
  it('serializes writes so a slow earlier snapshot cannot overwrite a completed answer', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const first = deferred<void>(); const save = repository.save.bind(repository);
    vi.mocked(repository.save).mockImplementationOnce(async value => { await first.promise; await save(value); });
    const turn = store.append('q', [], false); const id = store.current().id;
    store.update(id, turn.id, { phase: 'complete', answer: 'Final' });
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledOnce()); first.resolve(); await store.flush();
    expect(repository.saved.get(id)!.turns[0].answer).toBe('Final');
  });
  it('throttles streaming checkpoints and immediately saves a settled answer', async () => {
    vi.useFakeTimers(); const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const turn = store.append('q', [], false); const id = store.current().id; await store.flush(); vi.mocked(repository.save).mockClear();
    store.update(id, turn.id, { answer: 'a' }, true); store.update(id, turn.id, { answer: 'ab' }, true);
    await vi.advanceTimersByTimeAsync(999); expect(repository.save).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(repository.save).toHaveBeenCalledOnce();
    store.update(id, turn.id, { answer: 'abc', phase: 'complete' }); await store.flush(); expect(repository.saved.get(id)!.turns[0].answer).toBe('abc');
  });
  it('keeps chats usable in memory after saving fails', async () => {
    const repository = memoryRepository(); vi.mocked(repository.save).mockRejectedValue(new DOMException('Full', 'QuotaExceededError'));
    const store = new ConversationStore(repository); await store.initialize(); store.append('q', [], false); await store.flush();
    expect(store.current().turns).toHaveLength(1); expect(store.unsaved).toContain('Could not save');
  });
  it('retains the newest 50 nonempty conversations and clears legacy and current history', async () => {
    const repository = memoryRepository(); const storage = { getItem: () => null, removeItem: vi.fn() }; const store = new ConversationStore(repository, storage); await store.initialize();
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    for (let i = 0; i < CONVERSATION_LIMIT + 2; i++) { store.newChat(); store.append(`q${i}`, [], false); }
    await store.flush(); expect(store.conversations()).toHaveLength(50); expect(repository.saved.size).toBe(50);
    await store.clear(); expect(store.conversations()).toEqual([]); expect(repository.saved.size).toBe(0); expect(storage.removeItem).toHaveBeenCalledWith('ragbox-search-history');
  });
  it('orders rapid conversations deterministically when their wall-clock timestamps are equal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123); const store = new ConversationStore(memoryRepository()); await store.initialize();
    for (let i = 0; i < 52; i++) { store.newChat(); store.append(`q${i}`, [], false); }
    expect(store.conversations()[0].title).toBe('q51'); expect(store.current().title).toBe('q51'); expect(store.conversations()).toHaveLength(50);
    await store.flush();
  });
  it('searches conversation text and source titles and creates distinct anchors for repeated source IDs', () => {
    const conversation = importLegacyHistory(JSON.stringify([legacy]))[0];
    expect(matchesConversation(conversation, 'COFFEE sleep')).toBe(true); expect(matchesConversation(conversation, 'unknown')).toBe(false);
    expect(sourceAnchor('c1', 't1', 'MED-1')).not.toBe(sourceAnchor('c1', 't2', 'MED-1'));
  });
  it('sends on Enter while preserving Shift+Enter and composition input', () => {
    const send = vi.fn(); const preventDefault = vi.fn();
    handleComposerKey({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault }, send);
    handleComposerKey({ key: 'Enter', shiftKey: true, isComposing: false, preventDefault }, send);
    handleComposerKey({ key: 'Enter', shiftKey: false, isComposing: true, preventDefault }, send);
    expect(send).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
  });
});
