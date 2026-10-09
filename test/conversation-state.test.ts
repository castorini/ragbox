import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore, currentConversation, currentDraft } from '../src/conversations.ts';
import { deferred, memoryRepository } from './conversation-fixtures.ts';

afterEach(() => vi.useRealTimers());
describe('conversation state and persistence', () => {
  it('keeps reads pure and draft/control subscriptions separate from turns', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository);
    const startup = store.state.getState(); const initial = store.current();
    expect(store.current()).toBe(initial); expect(store.draft()).toBe('');
    expect(store.state.getState()).toBe(startup); expect(repository.navigate).not.toHaveBeenCalled();
    store.open('constructor'); expect(store.get('constructor')).toBeUndefined(); expect(store.state.getState()).toBe(startup);
    await store.initialize();
    const transcript = vi.fn(); const draft = vi.fn();
    store.watch(currentConversation, transcript); store.watch(currentDraft, draft);
    store.setDraft('next question'); store.setDraft('next question'); store.setThinkingEffort('high');
    expect(transcript).not.toHaveBeenCalled(); expect(draft).toHaveBeenCalledOnce();
    const first = store.append('First', [], false); const id = store.current().id;
    const second = store.append('Second', [], false);
    const previous = store.current(); transcript.mockClear();
    store.update(id, second.id, { answer: 'Chunk' }, true);
    expect(transcript).toHaveBeenCalledOnce();
    expect(store.current().turns[0]).toBe(previous.turns[0]);
    expect(store.current().turns[0].id).toBe(first.id);
    store.update(id, second.id, { answer: 'Chunk' }, true);
    store.update(id, 'absent', { answer: 'Unexpected' });
    expect(transcript).toHaveBeenCalledOnce(); await store.flush();
  });
  it('excludes drafts and operation identities from saved state and restores no active work', async () => {
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const turn = store.append('Question', [], false); const conversationId = store.current().id;
    store.setDraft('Unsubmitted'); store.setExecution({ conversationId, turnId: turn.id, attemptId: 'a1' });
    store.setPending({ conversationId, turnId: turn.id }); await store.flush();
    expect(repository.saved.get(conversationId)).not.toHaveProperty('activeOperation');
    const restored = new ConversationStore(repository); await restored.initialize();
    expect(restored.draft()).toBe(''); expect(restored.state.getState().activeOperation).toBeUndefined();
    expect(restored.state.getState().pendingTurn).toBeUndefined(); expect(restored.current().turns[0].phase).toBe('stopped');
  });
  it('cancels streaming checkpoints before clear, including slow queued writes', async () => {
    vi.useFakeTimers();
    const repository = memoryRepository(); const store = new ConversationStore(repository); await store.initialize();
    const slow = deferred<void>();
    vi.mocked(repository.save).mockImplementationOnce(async conversation => { await slow.promise; repository.saved.set(conversation.id, structuredClone(conversation)); });
    const turn = store.append('Question', [], false);
    store.update(store.current().id, turn.id, { answer: 'Partial' }, true);
    const clearing = store.clear();
    await vi.advanceTimersByTimeAsync(2000); slow.resolve(); await clearing; await store.flush();
    expect(repository.saved.size).toBe(0); expect(store.conversations()).toEqual([]);
    expect(repository.save).toHaveBeenCalledOnce();
  });
});
