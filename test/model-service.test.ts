import { describe, expect, it, vi } from 'vitest';
import { ModelService } from '../src/model-service.ts';
import type { WorkerRequest, WorkerResponse } from '../src/types.ts';
import { ResourceStates } from '../src/resource-state.ts';

class FakeWorker {
  messages: WorkerRequest[] = [];
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  postMessage = vi.fn((message: WorkerRequest) => { this.messages.push(message); });
  terminate = vi.fn();
  emit(data: WorkerResponse) { this.onmessage?.({ data }); }
}
async function harness(states?: ResourceStates) {
  const worker = new FakeWorker();
  const model = new ModelService({ workerFactory: () => worker as unknown as Worker, detectWebGPU: async () => ({ supported: true }), inspectCache: async () => 'installed',
    onState: states && ((phase, message, status) => states.set('model', phase, message, status)),
  });
  await model.initializeCapability(); await model.load(true);
  const load = worker.messages[0];
  if (load.type !== 'load') throw new Error('Expected load');
  worker.emit({ type: 'ready', model: 'test', revision: 'test', loadId: load.loadId });
  return { model, worker, abort: new AbortController() };
}
const operation = { conversationId: 'c1', turnId: 't1', attemptId: 'a1' };
const options = { corpus: 'nfcorpus' as const, question: 'coffee', documents: [{ id: 'MED-1', title: 'Coffee', text: 'Evidence' }], citationTargets: new Map([['MED-1', '#source']]), operation };

describe('headless model operations', () => {
  it('does not republish resource state for streamed or ignored worker deltas', async () => {
    const states = new ResourceStates(); const h = await harness(states); const onDelta = vi.fn();
    const answer = h.model.generateAnswer({ ...options, onDelta }, h.abort.signal);
    const request = h.worker.messages.at(-1)!; if (request.type !== 'generate') throw new Error('Expected answer');
    const resourceChanges = vi.fn(); states.watch(state => state, resourceChanges, false);
    h.worker.emit({ type: 'answer-delta', requestId: request.requestId, text: 'Finding' });
    h.worker.emit({ type: 'answer-delta', requestId: 'obsolete', text: 'Ignored' });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Finding'); expect(resourceChanges).not.toHaveBeenCalled();
    h.worker.emit({ type: 'complete', requestId: request.requestId, answer: 'Finding [MED-1].', documentIds: ['MED-1'] });
    await answer;
  });
  it('resolves a query with operation identity, ignoring late output from the cancelled attempt', async () => {
    const h = await harness();
    const first = h.model.resolveQuery('What about it?', [], h.abort.signal, operation);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const old = h.worker.messages.at(-1)!; if (old.type !== 'resolve-query') throw new Error('Expected query');
    expect(old.operation).toEqual(operation); h.abort.abort(); await rejected;
    const second = h.model.resolveQuery('How much?', [], new AbortController().signal, { ...operation, attemptId: 'a2' });
    const current = h.worker.messages.at(-1)!; if (current.type !== 'resolve-query') throw new Error('Expected query');
    h.worker.emit({ type: 'resolved-query', requestId: old.requestId, query: 'stale', contextLimited: false });
    expect(h.model.state).toBe('generating');
    h.worker.emit({ type: 'resolved-query', requestId: current.requestId, query: 'coffee amount', contextLimited: true });
    await expect(second).resolves.toEqual({ query: 'coffee amount', contextLimited: true });
    expect(h.model.state).toBe('ready');
  });
  it('rejects generation cancelled before any output and can start a fresh request', async () => {
    const h = await harness(); const answer = h.model.generateAnswer(options, h.abort.signal);
    const rejected = expect(answer).rejects.toMatchObject({ name: 'AbortError' }); h.abort.abort(); await rejected;
    expect(h.model.ready).toBe(true); expect(h.model.activeRequest).toBeNull();
    const next = h.model.generateAnswer(options, new AbortController().signal);
    const request = h.worker.messages.at(-1)!; if (request.type !== 'generate') throw new Error('Expected answer');
    h.worker.emit({ type: 'complete', requestId: request.requestId, answer: 'Finding [MED-1].', documentIds: ['MED-1'] });
    await expect(next).resolves.toEqual({ answer: 'Finding [MED-1].', documentIds: ['MED-1'] });
  });
  it('settles cancellation reported by the worker before any text is streamed', async () => {
    const h = await harness(); const answer = h.model.generateAnswer(options, h.abort.signal);
    const request = h.worker.messages.at(-1)!; if (request.type !== 'generate') throw new Error('Expected answer');
    const rejected = expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    h.worker.emit({ type: 'cancelled', requestId: request.requestId }); await rejected;
    expect(h.model.activeRequest).toBeNull(); expect(h.model.ready).toBe(true);
  });
  it('streams only matching request events and returns the fitted evidence IDs', async () => {
    const h = await harness(); const onDelta = vi.fn(); const onContext = vi.fn();
    const answer = h.model.generateAnswer({ ...options, history: [{ role: 'user', content: 'Earlier topic' }], searchQuery: 'resolved coffee', thinkingEffort: 'high', onDelta, onContext }, h.abort.signal);
    const request = h.worker.messages.at(-1)!; if (request.type !== 'generate') throw new Error('Expected answer');
    expect(request).toMatchObject({ operation, searchQuery: 'resolved coffee', thinkingEffort: 'high', history: [{ role: 'user', content: 'Earlier topic' }] });
    h.worker.emit({ type: 'answer-delta', requestId: 'old', text: 'stale' });
    h.worker.emit({ type: 'context', requestId: request.requestId, documentIds: ['MED-1'], contextLimited: true });
    h.worker.emit({ type: 'answer-delta', requestId: request.requestId, text: 'Finding' });
    h.worker.emit({ type: 'complete', requestId: request.requestId, answer: 'Finding [MED-1].', documentIds: ['MED-1'] });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Finding'); expect(onContext).toHaveBeenCalledExactlyOnceWith(['MED-1'], true);
    await expect(answer).resolves.toMatchObject({ documentIds: ['MED-1'] });
  });
  it('keeps reasoning separate from streamed answers and returns final reasoning from the worker', async () => {
    const h = await harness(); const onDelta = vi.fn(); const onThinkingDelta = vi.fn();
    const answer = h.model.generateAnswer({ ...options, onDelta, onThinkingDelta }, h.abort.signal);
    const request = h.worker.messages.at(-1)!; if (request.type !== 'generate') throw new Error('Expected answer');
    h.worker.emit({ type: 'thinking-delta', requestId: 'old', text: 'Stale reasoning' });
    h.worker.emit({ type: 'thinking-delta', requestId: request.requestId, text: 'Compare evidence [MED-1].' });
    expect(onThinkingDelta).toHaveBeenCalledExactlyOnceWith('Compare evidence [MED-1].');
    expect(onDelta).not.toHaveBeenCalled();
    h.worker.emit({ type: 'answer-delta', requestId: request.requestId, text: 'Supported finding [MED-1].' });
    h.worker.emit({ type: 'complete', requestId: request.requestId, answer: 'Supported finding [MED-1].', thinking: 'Compare evidence [MED-1]. Final reasoning.', documentIds: ['MED-1'] });
    await expect(answer).resolves.toEqual({ answer: 'Supported finding [MED-1].', thinking: 'Compare evidence [MED-1]. Final reasoning.', documentIds: ['MED-1'] });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Supported finding [MED-1].');
  });
  it('ignores cancelled reasoning events while a new request streams its own reasoning', async () => {
    const h = await harness(); const oldThinking = vi.fn(); const oldAnswer = vi.fn();
    const first = h.model.generateAnswer({ ...options, onThinkingDelta: oldThinking, onDelta: oldAnswer }, h.abort.signal);
    const old = h.worker.messages.at(-1)!; if (old.type !== 'generate') throw new Error('Expected answer');
    h.worker.emit({ type: 'thinking-delta', requestId: old.requestId, text: 'Interrupted reasoning [MED-1].' });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' }); h.abort.abort(); await rejected;
    const currentThinking = vi.fn(); const currentAnswer = vi.fn();
    const next = h.model.generateAnswer({ ...options, operation: { ...operation, attemptId: 'a2' }, onThinkingDelta: currentThinking, onDelta: currentAnswer }, new AbortController().signal);
    const current = h.worker.messages.at(-1)!; if (current.type !== 'generate') throw new Error('Expected answer');
    h.worker.emit({ type: 'thinking-delta', requestId: old.requestId, text: 'Late reasoning' });
    h.worker.emit({ type: 'answer-delta', requestId: old.requestId, text: 'Late answer' });
    h.worker.emit({ type: 'complete', requestId: old.requestId, answer: 'Late answer', thinking: 'Late reasoning', documentIds: [] });
    expect(oldThinking).toHaveBeenCalledExactlyOnceWith('Interrupted reasoning [MED-1].');
    expect(oldAnswer).not.toHaveBeenCalled(); expect(currentThinking).not.toHaveBeenCalled(); expect(currentAnswer).not.toHaveBeenCalled();
    h.worker.emit({ type: 'thinking-delta', requestId: current.requestId, text: 'Fresh reasoning' });
    h.worker.emit({ type: 'complete', requestId: current.requestId, answer: 'Fresh answer [MED-1].', documentIds: ['MED-1'] });
    await expect(next).resolves.toEqual({ answer: 'Fresh answer [MED-1].', thinking: 'Fresh reasoning', documentIds: ['MED-1'] });
    expect(currentThinking).toHaveBeenCalledExactlyOnceWith('Fresh reasoning');
  });
  it('settles a query on worker failure and exposes recovery', async () => {
    const h = await harness(); const query = h.model.resolveQuery('it?', [], h.abort.signal);
    const rejected = expect(query).rejects.toThrow('GPU stopped');
    h.worker.onerror?.({ message: 'GPU stopped', preventDefault: vi.fn() }); await rejected;
    expect(h.model.state).toBe('error'); expect(h.worker.terminate).toHaveBeenCalled();
  });
  it('clears active generation when posting a request fails', async () => {
    const h = await harness(); h.worker.postMessage.mockImplementationOnce(() => { throw new Error('Worker unavailable'); });
    await expect(h.model.generateAnswer(options, h.abort.signal)).rejects.toThrow('Worker unavailable');
    expect(h.model.activeRequest).toBeNull(); expect(h.model.state).toBe('ready');
  });
});
