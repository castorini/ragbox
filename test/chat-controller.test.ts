import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../src/chat-controller.ts';
import { ConversationStore } from '../src/conversations.ts';
import type { ModelService, ControllerState } from '../src/model-service.ts';
import type { ChatMessage, ChatOperation, ModelStatus, RetrievalResult } from '../src/types.ts';
import { deferred, memoryRepository } from './conversation-fixtures.ts';
import { ResourceStates } from '../src/resource-state.ts';

const documents = [{ id: 'MED-1', title: 'Evidence', text: 'Supported finding.', score: 2 }];
const operation = expect.objectContaining({ conversationId: expect.any(String), turnId: expect.any(String), attemptId: expect.any(String) });
class FakeModel {
  ready = true;
  state: ControllerState = 'ready';
  model: ModelStatus = { cache: 'installed', stage: 'ready', downloadedBytes: 0 };
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setState(state: ControllerState) { this.state = state; this.ready = state === 'ready'; for (const listener of this.listeners) listener(); }
  resolveQuery = vi.fn(async (_question: string, _history: ChatMessage[], _signal: AbortSignal) => ({ query: 'coffee blood pressure', contextLimited: false }));
  generateAnswer = vi.fn(async (options: Parameters<ModelService['generateAnswer']>[0], _signal: AbortSignal) => {
    const id = options.documents[0].id;
    options.onContext?.([id], false); options.onDelta?.(`A finding [${id}].`);
    return { answer: `A finding [${id}].`, documentIds: [id] };
  });
}
async function harness() {
  const repository = memoryRepository();
  const store = new ConversationStore(repository); await store.initialize();
  const model = new FakeModel();
  const resources = { ready: vi.fn(() => true), busy: vi.fn(() => false), retrieve: vi.fn(async (_corpus: string, _query: string, _operation: ChatOperation): Promise<RetrievalResult> => ({ documents, elapsedMs: 4 })) };
  const chat = new ChatController(store, model, resources);
  return { repository, store, model, resources, chat, latest: () => store.current().turns.at(-1)! };
}

describe('chat orchestration', () => {
  it('resumes after resource cleanup without a mounted view and releases subscriptions on disposal', async () => {
    const store = new ConversationStore(memoryRepository()); await store.initialize();
    const states = new ResourceStates(); states.set('nfcorpus', 'ready', 'Ready');
    const model = new FakeModel(); model.setState('idle');
    let adapterReady = true;
    const retrieve = vi.fn(async () => {
      if (!adapterReady) throw new Error('Adapter cleanup has not finished');
      return { documents, elapsedMs: 1 };
    });
    const chat = new ChatController(store, model, {
      ready: corpus => states.get(corpus).phase === 'ready', busy: () => states.busy, retrieve,
      subscribe: listener => states.watch(state => [state.busy, state.resources.nfcorpus.phase], listener, false),
    });
    await chat.send('coffee'); expect(store.current().turns[0].phase).toBe('blocked');
    states.setBusy(true); adapterReady = false; model.setState('ready');
    states.setBusy(false);
    await Promise.resolve(); adapterReady = true;
    await vi.waitFor(() => expect(store.current().turns[0].phase).toBe('complete'));
    expect(model.generateAnswer).toHaveBeenCalledOnce();
    expect(store.state.getState().activeOperation).toBeUndefined(); expect(chat.canSend()).toBe(true);
    chat.dispose(); const snapshot = store.state.getState();
    model.setState('loading'); states.setBusy(true); states.setBusy(false); model.setState('ready');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.state.getState()).toBe(snapshot); expect(chat.canSend()).toBe(false);
    await store.flush();
  });
  it('publishes active-operation completion separately from the final answer', async () => {
    const h = await harness(); const activity: boolean[] = [];
    h.store.watch(state => !!state.activeOperation, active => activity.push(active));
    await h.chat.send('coffee');
    expect(activity).toEqual([true, false]); expect(h.latest().phase).toBe('complete'); expect(h.chat.running).toBe(false);
    h.chat.dispose(); await h.store.flush();
  });
  it('keeps submitted effort through retrieval and retry when the preference changes', async () => {
    const h = await harness(); h.store.setThinkingEffort('high');
    const retrieval = deferred<RetrievalResult>(); h.resources.retrieve.mockReturnValueOnce(retrieval.promise);
    h.model.generateAnswer.mockRejectedValueOnce(new Error('Generation failed'));
    const sending = h.chat.send('coffee'); h.store.setThinkingEffort('low');
    retrieval.resolve({ documents, elapsedMs: 1 }); await sending;
    expect(h.latest().phase).toBe('error');
    expect(h.model.generateAnswer.mock.calls[0][0].thinkingEffort).toBe('high');
    await h.chat.retry();
    expect(h.model.generateAnswer.mock.calls[1][0].thinkingEffort).toBe('high');
    expect(h.store.current().turns).toHaveLength(1); expect(h.latest().phase).toBe('complete');
    await h.chat.send('And blood pressure?');
    expect(h.model.generateAnswer.mock.calls[2][0].thinkingEffort).toBe('low');
  });
  it('keeps captured effort when model recovery resumes a keyword-only turn', async () => {
    const h = await harness(); h.model.setState('idle'); h.store.setThinkingEffort('low');
    await h.chat.send('coffee'); h.store.setThinkingEffort('high'); h.model.setState('ready');
    await vi.waitFor(() => expect(h.latest().phase).toBe('complete'));
    expect(h.model.generateAnswer.mock.calls[0][0].thinkingEffort).toBe('low');
  });
  it('retrieves the first question directly and resolves a follow-up with the completed conversation', async () => {
    const h = await harness();
    await h.chat.send('coffee');
    expect(h.model.resolveQuery).not.toHaveBeenCalled();
    expect(h.latest()).toMatchObject({ phase: 'complete', question: 'coffee', searchQuery: 'coffee', citedIds: ['MED-1'] });
    await h.chat.send('What does it do to blood pressure?');
    expect(h.model.resolveQuery).toHaveBeenCalledWith('What does it do to blood pressure?', [{ role: 'user', content: 'coffee' }, { role: 'assistant', content: 'A finding [MED-1].' }], expect.any(AbortSignal), operation);
    expect(h.resources.retrieve).toHaveBeenLastCalledWith('nfcorpus', 'coffee blood pressure', operation);
    expect(h.store.current().turns).toHaveLength(2);
  });
  it('uses the resolved new topic without adding earlier keywords to retrieval', async () => {
    const h = await harness(); await h.chat.send('coffee');
    h.model.resolveQuery.mockResolvedValue({ query: 'vitamin d', contextLimited: false });
    await h.chat.send('Now tell me about vitamin D');
    expect(h.resources.retrieve).toHaveBeenLastCalledWith('nfcorpus', 'vitamin d', operation);
  });
  it('keeps literal search usable without a model and completes only the latest pending turn after loading', async () => {
    const h = await harness(); h.model.setState('idle');
    await h.chat.send('coffee'); await h.chat.send('What about blood pressure?');
    expect(h.latest()).toMatchObject({ phase: 'blocked', keywordOnly: true });
    expect(h.model.generateAnswer).not.toHaveBeenCalled();
    h.model.setState('ready');
    await vi.waitFor(() => expect(h.latest().phase).toBe('complete'));
    expect(h.model.generateAnswer).toHaveBeenCalledOnce();
    expect(h.store.current().turns[0].phase).toBe('blocked');
    expect(h.resources.retrieve).toHaveBeenLastCalledWith('nfcorpus', 'coffee blood pressure', operation);
  });
  it('unblocks the composer when queued model loading fails', async () => {
    const h = await harness(); h.model.setState('loading'); await h.chat.send('coffee');
    expect(h.latest().phase).toBe('waiting'); expect(h.chat.running).toBe(true);
    h.model.setState('error');
    expect(h.latest().phase).toBe('blocked'); expect(h.chat.canSend()).toBe(true);
  });
  it('skips generation for empty retrieval and preserves an insufficient-evidence turn', async () => {
    const h = await harness(); h.resources.retrieve.mockResolvedValue({ documents: [], elapsedMs: 1 });
    await h.chat.send('unmatched');
    expect(h.model.generateAnswer).not.toHaveBeenCalled(); expect(h.latest().answer).toContain('do not contain enough information');
  });
  it('offers retry after rewriting fails without retrieving a guessed query', async () => {
    const h = await harness(); await h.chat.send('coffee');
    h.model.resolveQuery.mockRejectedValueOnce(new Error('Invalid query'));
    await h.chat.send('What about that?');
    expect(h.latest()).toMatchObject({ phase: 'error', stage: 'resolve' }); expect(h.resources.retrieve).toHaveBeenCalledOnce();
    await h.chat.retry(); expect(h.latest().phase).toBe('complete'); expect(h.store.current().turns).toHaveLength(2); expect(h.model.resolveQuery).toHaveBeenCalledTimes(2);
  });
  it('invalidates a stopped retrieval and its late completion', async () => {
    const h = await harness(); const result = deferred<RetrievalResult>(); h.resources.retrieve.mockReturnValueOnce(result.promise);
    const sending = h.chat.send('coffee'); h.chat.stop(); result.resolve({ documents, elapsedMs: 1 }); await sending;
    expect(h.latest()).toMatchObject({ phase: 'stopped', results: [], answer: '' }); expect(h.model.generateAnswer).not.toHaveBeenCalled();
  });
  it('ignores a resolved query from an abandoned conversation', async () => {
    const h = await harness(); await h.chat.send('coffee'); const resolved = deferred<{ query: string; contextLimited: boolean }>();
    h.model.resolveQuery.mockReturnValueOnce(resolved.promise);
    const sending = h.chat.send('What about that?'); const old = h.store.current().id; h.chat.newChat();
    resolved.resolve({ query: 'old query', contextLimited: false }); await sending;
    expect(h.store.current().turns).toHaveLength(0); expect(h.store.get(old)!.turns.at(-1)!.phase).toBe('stopped'); expect(h.resources.retrieve).toHaveBeenCalledOnce();
  });
  it('keeps partial text and valid citations on Stop, ignoring late deltas', async () => {
    const h = await harness(); const result = deferred<{ answer: string; documentIds: string[] }>();
    let options!: Parameters<ModelService['generateAnswer']>[0];
    h.model.generateAnswer.mockImplementationOnce(async value => { options = value; value.onContext?.(['MED-1'], false); value.onDelta?.('Partial [MED-1]'); return result.promise; });
    const sending = h.chat.send('coffee'); await vi.waitFor(() => expect(h.latest().phase).toBe('generating'));
    h.chat.stop(); options.onDelta?.(' late'); result.resolve({ answer: 'Late answer', documentIds: [] }); await sending;
    expect(h.latest()).toMatchObject({ phase: 'stopped', answer: 'Partial [MED-1]', citedIds: ['MED-1'] });
    await h.chat.retry(); expect(h.resources.retrieve).toHaveBeenCalledOnce(); expect(h.store.current().turns).toHaveLength(1); expect(h.latest().phase).toBe('complete');
  });
  it('uses only the final answer for citations and subsequent conversation history', async () => {
    const h = await harness();
    h.resources.retrieve.mockResolvedValueOnce({ documents: [...documents, { ...documents[0], id: 'MED-2', text: 'Final evidence' }], elapsedMs: 1 });
    h.model.generateAnswer.mockImplementationOnce(async options => {
      options.onContext?.(['MED-1', 'MED-2'], false);
      options.onThinkingDelta?.('Private comparison [MED-1] and unknown [MED-404].');
      expect(h.latest().answer).toBe(''); expect(h.latest().citedIds).toEqual([]);
      options.onDelta?.('Final finding [MED-2].');
      return { answer: 'Final finding [MED-2].', thinking: 'Private comparison [MED-1] and unknown [MED-404].', documentIds: ['MED-1', 'MED-2'] };
    });
    await h.chat.send('coffee');
    expect(h.latest()).toMatchObject({ phase: 'complete', answer: 'Final finding [MED-2].', thinking: 'Private comparison [MED-1] and unknown [MED-404].', citedIds: ['MED-2'] });
    await h.chat.send('What about it?');
    expect(h.model.resolveQuery).toHaveBeenCalledWith('What about it?', [{ role: 'user', content: 'coffee' }, { role: 'assistant', content: 'Final finding [MED-2].' }], expect.any(AbortSignal), operation);
    expect(h.latest().history.some(message => message.content.includes('Private comparison'))).toBe(false);
    expect(h.model.generateAnswer.mock.calls[1][0].history).toEqual(h.latest().history);
  });
  it('saves stopped reasoning with no answer and resets it on Retry without creating another turn', async () => {
    const h = await harness(); const result = deferred<{ answer: string; thinking: string; documentIds: string[] }>();
    let oldOptions!: Parameters<ModelService['generateAnswer']>[0];
    h.model.generateAnswer.mockImplementationOnce(async options => {
      oldOptions = options; options.onContext?.(['MED-1'], false); options.onThinkingDelta?.('Unfinished comparison [MED-1].');
      return result.promise;
    });
    const sending = h.chat.send('coffee'); await vi.waitFor(() => expect(h.latest().thinking).toBe('Unfinished comparison [MED-1].'));
    const id = h.latest().id; h.chat.stop();
    oldOptions.onThinkingDelta?.(' Late reasoning'); oldOptions.onDelta?.('Late answer [MED-1].');
    result.resolve({ answer: 'Late answer [MED-1].', thinking: 'Late reasoning', documentIds: ['MED-1'] }); await sending;
    expect(h.latest()).toMatchObject({ id, phase: 'stopped', thinking: 'Unfinished comparison [MED-1].', answer: '', citedIds: [] });
    await h.store.flush(); expect(h.repository.saved.get(h.store.current().id)!.turns[0]).toMatchObject({ thinking: 'Unfinished comparison [MED-1].', answer: '', phase: 'stopped' });
    const retryResult = deferred<{ answer: string; thinking: string; documentIds: string[] }>();
    h.model.generateAnswer.mockImplementationOnce(async options => {
      expect(h.latest()).toMatchObject({ id, phase: 'generating', thinking: '', answer: '', citedIds: [] });
      options.onContext?.(['MED-1'], false); options.onThinkingDelta?.('Fresh comparison');
      return retryResult.promise;
    });
    const retrying = h.chat.retry(); await vi.waitFor(() => expect(h.latest().thinking).toBe('Fresh comparison'));
    oldOptions.onThinkingDelta?.(' More stale reasoning'); expect(h.latest().thinking).toBe('Fresh comparison');
    retryResult.resolve({ answer: 'Fresh finding [MED-1].', thinking: 'Fresh comparison', documentIds: ['MED-1'] }); await retrying;
    expect(h.store.current().turns).toHaveLength(1); expect(h.resources.retrieve).toHaveBeenCalledOnce();
    expect(h.latest()).toMatchObject({ id, phase: 'complete', thinking: 'Fresh comparison', answer: 'Fresh finding [MED-1].', citedIds: ['MED-1'] });
  });
  it('keeps abandoned reasoning attached to its old turn and ignores events after New chat', async () => {
    const h = await harness(); const result = deferred<{ answer: string; thinking: string; documentIds: string[] }>();
    let oldOptions!: Parameters<ModelService['generateAnswer']>[0];
    h.model.generateAnswer.mockImplementationOnce(async options => {
      oldOptions = options; options.onContext?.(['MED-1'], false); options.onThinkingDelta?.('Old comparison [MED-1].');
      return result.promise;
    });
    const sending = h.chat.send('coffee'); await vi.waitFor(() => expect(h.latest().thinking).toBe('Old comparison [MED-1].'));
    const oldConversation = h.store.current().id; h.chat.newChat(); await h.chat.send('New subject');
    oldOptions.onThinkingDelta?.(' Late'); oldOptions.onDelta?.('Late answer [MED-1].');
    result.resolve({ answer: 'Late answer [MED-1].', thinking: 'Old comparison Late', documentIds: ['MED-1'] }); await sending;
    expect(h.store.get(oldConversation)!.turns[0]).toMatchObject({ phase: 'stopped', thinking: 'Old comparison [MED-1].', answer: '', citedIds: [] });
    expect(h.latest()).toMatchObject({ phase: 'complete', question: 'New subject', thinking: '', answer: 'A finding [MED-1].' });
    expect(h.store.current().turns).toHaveLength(1);
  });
  it('restores separate chats per collection and does not resume saved unanswered turns automatically', async () => {
    const h = await harness(); await h.chat.send('coffee'); const nf = h.store.current().id;
    h.chat.select('msmarco'); await h.chat.send('thunder'); expect(h.resources.retrieve).toHaveBeenLastCalledWith('msmarco', 'thunder', operation);
    h.chat.select('nfcorpus'); expect(h.store.current().id).toBe(nf);
    await h.store.flush(); const restored = new ConversationStore(h.repository); await restored.initialize();
    const model = new FakeModel(); new ChatController(restored, model, h.resources); expect(model.generateAnswer).not.toHaveBeenCalled();
  });
  it('limits the model history to recent turns while retaining the full transcript', async () => {
    const h = await harness(); for (let i = 0; i < 5; i++) await h.chat.send(`question ${i}`);
    expect(h.store.current().turns).toHaveLength(5); expect(h.latest().history.filter(message => message.role === 'user')).toHaveLength(3); expect(h.latest().contextLimited).toBe(true);
  });
  it('retries a failed retrieval with its resolved query and a fresh attempt ID', async () => {
    const h = await harness(); h.resources.retrieve.mockRejectedValueOnce(new Error('Database busy'));
    await h.chat.send('coffee'); const first = h.resources.retrieve.mock.calls[0][2];
    expect(h.latest()).toMatchObject({ phase: 'error', stage: 'retrieve', searchQuery: 'coffee' });
    await h.chat.retry(); const second = h.resources.retrieve.mock.calls[1][2];
    expect(second).toMatchObject({ conversationId: first.conversationId, turnId: first.turnId });
    expect(second.attemptId).not.toBe(first.attemptId); expect(h.store.current().turns).toHaveLength(1);
  });
  it('stops queued model work and does not resume when it later becomes ready', async () => {
    const h = await harness(); h.model.setState('loading'); await h.chat.send('coffee'); h.chat.stop();
    h.model.setState('ready'); await Promise.resolve();
    expect(h.latest().phase).toBe('stopped'); expect(h.model.generateAnswer).not.toHaveBeenCalled();
  });
  it('stops a resolving turn on collection switching and ignores the old result', async () => {
    const h = await harness(); await h.chat.send('coffee'); const id = h.store.current().id;
    const resolved = deferred<{ query: string; contextLimited: boolean }>(); h.model.resolveQuery.mockReturnValueOnce(resolved.promise);
    const sending = h.chat.send('What about it?'); h.chat.select('msmarco');
    resolved.resolve({ query: 'coffee effects', contextLimited: false }); await sending;
    expect(h.store.get(id)!.turns.at(-1)!.phase).toBe('stopped'); expect(h.resources.retrieve).toHaveBeenCalledOnce();
    h.chat.select('nfcorpus'); expect(h.store.current().id).toBe(id);
  });
  it('reuses the original generation snapshot after model recovery', async () => {
    const h = await harness(); await h.chat.send('coffee'); await h.chat.send('What about it?');
    const result = deferred<{ answer: string; documentIds: string[] }>(); h.model.generateAnswer.mockReturnValueOnce(result.promise);
    h.store.update(h.store.current().id, h.latest().id, { phase: 'stopped' }); h.model.setState('idle');
    await h.chat.retry(); expect(h.latest().keywordOnly).toBe(false); expect(h.latest().phase).toBe('blocked');
    h.model.setState('ready'); await vi.waitFor(() => expect(h.latest().phase).toBe('generating'));
    result.resolve({ answer: 'Recovered [MED-1].', documentIds: ['MED-1'] }); await vi.waitFor(() => expect(h.latest().phase).toBe('complete'));
    expect(h.resources.retrieve).toHaveBeenCalledTimes(2); expect(h.model.resolveQuery).toHaveBeenCalledOnce();
  });
  it('keeps an earlier citation attached to its original results after another question and reload', async () => {
    const h = await harness(); await h.chat.send('coffee');
    h.resources.retrieve.mockResolvedValue({ documents: [{ ...documents[0], id: 'MED-2', text: 'Different evidence' }], elapsedMs: 1 });
    await h.chat.send('New topic'); await h.store.flush();
    const restored = new ConversationStore(h.repository); await restored.initialize();
    expect(restored.current().turns[0]).toMatchObject({ results: documents, includedIds: ['MED-1'], citedIds: ['MED-1'] });
    expect(restored.current().turns[1]).toMatchObject({ includedIds: ['MED-2'], citedIds: ['MED-2'] });
  });
});
