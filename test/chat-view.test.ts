import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatModel } from '../src/chat-controller.ts';
import { setupChatView, setupConversationHistory } from '../src/chat-view.ts';
import { ConversationStore } from '../src/conversations.ts';
import { ResourceStates } from '../src/resource-state.ts';
import { memoryRepository } from './conversation-fixtures.ts';

class Node {
  children: Node[] = [];
  parent?: Node;
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty: (name: string, value: string) => { this.style[name] = value; } };
  hidden = false; disabled = false; open = false; value = ''; className = ''; id = ''; tabIndex = 0;
  offsetHeight = 50; scrollHeight = 40; writes = 0;
  private text = '';
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; this.writes++; }
  append(...items: Node[]) { for (const item of items) item.parent = this; this.children.push(...items); }
  appendChild(item: Node) { this.append(item); return item; }
  replaceChildren(...items: Node[]) { this.writes++; this.children = []; this.append(...items); }
  insertBefore(item: Node, before: Node | null) {
    item.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, item); item.parent = this;
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  setAttribute() { this.writes++; }
  removeAttribute() { this.writes++; }
  toggleAttribute() { this.writes++; }
  focus = vi.fn();
  scrollIntoView = vi.fn();
}
const mutations = (node: Node): number => node.writes + node.children.reduce((sum, child) => sum + mutations(child), 0);

async function harness() {
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const document = { querySelector: get, createElement: () => new Node(), createElementNS: () => new Node(), activeElement: get('#chat-query'), documentElement: { scrollHeight: 1000 },
    addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), scrollY: 400, innerHeight: 600, scrollTo: vi.fn() };
  const frame = vi.fn();
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('requestAnimationFrame', frame);
  const store = new ConversationStore(memoryRepository()); await store.initialize();
  const states = new ResourceStates(); states.set('nfcorpus', 'ready', 'Ready'); states.set('msmarco', 'ready', 'Ready');
  const model: ChatModel = {
    ready: true, state: 'ready', model: { cache: 'installed', stage: 'ready', downloadedBytes: 0 },
    subscribe: () => () => {}, resolveQuery: async () => ({ query: 'coffee', contextLimited: false }),
    generateAnswer: async () => ({ answer: 'Answer', documentIds: [] }),
  };
  const chat = new ChatController(store, model, { ready: () => true, busy: () => states.busy, retrieve: async () => ({ documents: [], elapsedMs: 1 }) });
  const view = setupChatView(chat, states);
  return { get, store, states, chat, view, document, window, frame };
}
afterEach(() => vi.unstubAllGlobals());

describe('focused chat subscriptions', () => {
  it('updates only the changed turn and preserves expanded sources, focus and drafts during streaming', async () => {
    const h = await harness();
    const first = h.store.append('First', [], false); const id = h.store.current().id;
    h.store.update(id, first.id, { phase: 'complete', answer: 'Earlier answer' });
    const turn = h.store.append('Second', [], false);
    h.store.update(id, turn.id, { phase: 'generating', thinking: 'Reasoning', results: [{ id: 'MED-1', title: 'Study', text: 'Evidence', score: 1 }] });
    const transcript = h.get('#chat-transcript'); const earlier = transcript.children[0]; const latest = transcript.children[1];
    const thinking = latest.children[1].children[1]; const sources = latest.children[1].children[5];
    thinking.open = true; sources.open = true;
    const sourceNodes = sources.children; const previousWrites = mutations(earlier);
    h.get('#chat-query').value = 'Unsent draft'; h.store.setDraft('Unsent draft');
    h.store.update(id, turn.id, { answer: 'A streamed answer', thinking: 'Reasoning continued' }, true);
    expect(mutations(earlier)).toBe(previousWrites);
    expect(thinking.open).toBe(true); expect(sources.open).toBe(true); expect(sources.children).toBe(sourceNodes);
    expect(h.get('#chat-query').value).toBe('Unsent draft'); expect(h.document.activeElement).toBe(h.get('#chat-query'));
    h.frame.mockClear(); const writes = mutations(transcript);
    h.store.setDraft('Edited draft'); h.states.set('model', 'loading', 'Downloading', { cache: 'installed', stage: 'downloading', downloadedBytes: 100 });
    h.states.setBusy(true); h.states.setBusy(false);
    expect(mutations(transcript)).toBe(writes); expect(h.frame).not.toHaveBeenCalled();
    h.view.dispose(); h.chat.dispose(); await h.store.flush();
  });
  it('updates Send/Stop on operation settlement and removes view subscriptions on disposal', async () => {
    const h = await harness(); const turn = h.store.append('Question', [], false); const conversationId = h.store.current().id;
    h.store.setDraft('Next'); h.get('#chat-query').value = 'Next';
    h.store.setExecution({ conversationId, turnId: turn.id, attemptId: 'a1' });
    expect(h.get('#chat-send').dataset.mode).toBe('stop');
    h.store.update(conversationId, turn.id, { phase: 'complete', answer: 'Done' });
    h.store.setExecution();
    expect(h.get('#chat-send').dataset.mode).toBe('send'); expect(h.get('#chat-send').disabled).toBe(false);
    h.view.dispose(); const writes = mutations(h.get('#chat-transcript'));
    h.store.update(conversationId, turn.id, { answer: 'After disposal' });
    expect(mutations(h.get('#chat-transcript'))).toBe(writes);
    expect(h.window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    h.chat.dispose(); await h.store.flush();
  });
  it('offers starter questions from the search box during a chat and sends a chosen one', async () => {
    const h = await harness(); const suggestions = h.get('#chat-suggestions'); const query = h.get('#chat-query') as Node & { onfocus?: () => void; oninput?: () => void; onblur?: () => void; onkeydown?: (event: { key: string; preventDefault(): void }) => void };
    expect(suggestions.children).toHaveLength(3);
    query.onfocus?.(); expect(suggestions.hidden).toBe(true); // start page lists them already
    const turn = h.store.append('First', [], false); h.store.update(h.store.current().id, turn.id, { phase: 'complete', answer: 'Done' });
    query.onfocus?.(); expect(suggestions.hidden).toBe(false);
    query.value = 'typing'; query.oninput?.(); expect(suggestions.hidden).toBe(true);
    query.value = ''; query.oninput?.(); expect(suggestions.hidden).toBe(false);
    query.onblur?.(); expect(suggestions.hidden).toBe(true);
    query.onfocus?.(); const question = suggestions.children[1].textContent;
    (suggestions.children[1] as Node & { onclick?: () => void }).onclick?.();
    expect(suggestions.hidden).toBe(true);
    await vi.waitFor(() => expect(h.store.current().turns.map(item => item.question)).toEqual(['First', question]));
    // Focus stays in the box after sending: a click or ArrowDown still reopens the list.
    expect(suggestions.hidden).toBe(true);
    (query as Node & { onclick?: () => void }).onclick?.(); expect(suggestions.hidden).toBe(false);
    query.onkeydown?.({ key: 'Escape', preventDefault() {} }); expect(suggestions.hidden).toBe(true);
    query.onkeydown?.({ key: 'ArrowDown', preventDefault() {} }); expect(suggestions.hidden).toBe(false);
    h.view.dispose(); h.chat.dispose(); await h.store.flush();
  });
  it('scrolls a newly asked question to the top and leaves scrolling to the reader while it streams', async () => {
    const h = await harness(); const id = h.store.current().id;
    const first = h.store.append('First', [], false); h.store.update(id, first.id, { phase: 'complete', answer: 'Done' });
    h.frame.mock.calls.at(-1)![0](); expect(h.window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    h.frame.mockClear();
    const second = h.store.append('Second', [], false);
    expect(h.frame).toHaveBeenCalledOnce(); h.frame.mock.calls[0][0]();
    const row = h.get('#chat-transcript').children[1];
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    h.frame.mockClear();
    h.store.update(id, second.id, { phase: 'generating', answer: 'Streaming text' }, true);
    expect(h.frame).not.toHaveBeenCalled();
    h.view.dispose(); h.chat.dispose(); await h.store.flush();
  });
  it('tags each reply with its current activity for the progress animations', async () => {
    const h = await harness(); const turn = h.store.append('Question', [], false); const id = h.store.current().id;
    const activity = () => h.get('#chat-transcript').children[0].dataset.activity;
    h.store.update(id, turn.id, { phase: 'resolving' }); expect(activity()).toBe('resolving');
    h.store.update(id, turn.id, { phase: 'retrieving' }); expect(activity()).toBe('searching');
    h.store.update(id, turn.id, { phase: 'generating', thinkingEffort: 'off' }); expect(activity()).toBe('preparing');
    h.store.update(id, turn.id, { thinkingEffort: 'on' }); expect(activity()).toBe('thinking');
    h.store.update(id, turn.id, { answer: 'Partial' }, true); expect(activity()).toBe('writing');
    h.store.update(id, turn.id, { phase: 'complete', answer: 'Done' }); expect(activity()).toBe('');
    h.view.dispose(); h.chat.dispose(); await h.store.flush();
  });
  it('updates changed history cards without rewriting other conversations', async () => {
    const h = await harness(); h.store.append('First', [], false); h.store.newChat();
    const turn = h.store.append('Second', [], false); const id = h.store.current().id;
    const history = setupConversationHistory(h.chat, () => {});
    const list = h.get('#history-list'); const earlier = list.children[1]; const previousWrites = mutations(earlier);
    h.store.update(id, turn.id, { answer: 'Streamed answer' }, true);
    expect(mutations(earlier)).toBe(previousWrites);
    history.dispose(); h.view.dispose(); h.chat.dispose(); await h.store.flush();
  });
});
