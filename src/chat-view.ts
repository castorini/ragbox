import { requiredElement } from './boundaries.ts';
import { renderAnswer } from './llm-controller.ts';
import { EXAMPLE_QUERIES } from './example-queries.ts';
import { MAX_QUESTION_LENGTH, type ChatController } from './chat-controller.ts';
import type { ResourceStates } from './resource-state.ts';
import type { ChatTurn, Conversation } from './types.ts';
import { currentConversation, currentDraft } from './conversations.ts';

export function sourceAnchor(conversationId: string, turnId: string, documentId: string) {
  return `chat-source-${encodeURIComponent(conversationId)}-${encodeURIComponent(turnId)}-${encodeURIComponent(documentId)}`;
}
export function handleComposerKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'preventDefault'>, send: () => void) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
}

// Icon-only Send button: an up arrow, or a square while a reply is being written.
const SEND_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>';

export function setupChatView(controller: ChatController, states: ResourceStates) {
  const { store } = controller;
  const form = requiredElement<HTMLFormElement>('#chat-form');
  const query = requiredElement<HTMLTextAreaElement>('#chat-query');
  const send = requiredElement<HTMLButtonElement>('#chat-send');
  const lengthWarning = requiredElement<HTMLElement>('#chat-length-warning');
  const effort = requiredElement<HTMLSelectElement>('#chat-thinking-effort');
  const transcript = requiredElement<HTMLElement>('#chat-transcript');
  const title = requiredElement<HTMLElement>('#chat-title');
  const empty = requiredElement<HTMLElement>('#chat-empty');
  const examples = requiredElement<HTMLElement>('#chat-examples');
  const unsaved = requiredElement<HTMLElement>('#chat-unsaved');
  const dashboard = requiredElement<HTMLElement>('#corpus-dashboard');
  const modelStatus = requiredElement<HTMLElement>('#model-search-status');
  const workspace = requiredElement<HTMLElement>('#search-view');
  let conversationId = '';
  let draftConversationId = '';
  let disposed = false;
  let exampleCorpus = '';
  type Row = { root: HTMLElement; answer: HTMLElement; thinking: HTMLDetailsElement; thinkingSummary: HTMLElement; thinkingText: HTMLElement; status: HTMLElement; context: HTMLElement; sources: HTMLDetailsElement; copy: HTMLButtonElement; retry: HTMLButtonElement; feedback: HTMLElement; metadata?: HTMLElement; results?: ChatTurn['results']; answerKey?: string; turn?: ChatTurn; latest?: boolean };
  const rows = new Map<string, Row>();
  const element = <T extends keyof HTMLElementTagNameMap>(tag: T, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const resize = () => {
    query.style.height = 'auto'; query.style.height = `${Math.min(query.scrollHeight, 150)}px`;
    if (form.offsetHeight) workspace.style.paddingBottom = `${form.offsetHeight + 20}px`;
  };
  window.addEventListener('resize', resize);
  const submit = () => {
    if (!controller.canSend() || !query.value.trim() || tooLong()) return;
    const question = query.value; query.value = ''; store.setDraft(''); resize();
    void controller.send(question);
  };
  form.onsubmit = event => { event.preventDefault(); if (controller.running) controller.stop(); else submit(); };
  query.onkeydown = event => handleComposerKey(event, submit);
  query.oninput = () => { store.setDraft(query.value); resize(); renderControls(); };
  effort.onchange = () => { store.setThinkingEffort(effort.value); };
  requiredElement<HTMLButtonElement>('#chat-new').onclick = () => { controller.newChat(); query.focus(); };

  const tooLong = () => query.value.trim().length > MAX_QUESTION_LENGTH;
  function renderControls() {
    const length = query.value.trim().length;
    lengthWarning.hidden = !tooLong();
    lengthWarning.textContent = tooLong()
      ? `Your question is ${length} characters. Shorten it to ${MAX_QUESTION_LENGTH} or fewer to send.`
      : '';
    query.toggleAttribute('aria-invalid', tooLong());
    effort.value = store.thinkingEffort;
    effort.disabled = !store.initialized;
    const mode = controller.running ? 'stop' : 'send';
    if (send.dataset.mode !== mode) {
      send.dataset.mode = mode;
      send.innerHTML = mode === 'stop' ? STOP_ICON : SEND_ICON;
      send.title = mode === 'stop' ? 'Stop' : 'Send';
    }
    send.setAttribute('aria-label', controller.running ? 'Stop current reply' : 'Send message');
    send.disabled = controller.running ? false : !controller.canSend() || !query.value.trim() || tooLong();
    query.setAttribute('aria-describedby', `${store.selected === 'nfcorpus' ? 'fts-help' : 'marco-help'}${tooLong() ? ' chat-length-warning' : ''}`);
    const conversation = store.current();
    const latest = conversation.turns.at(-1);
    const row = latest && rows.get(latest.id);
    if (row) row.retry.disabled = controller.running || states.busy || states.get(conversation.corpus).phase !== 'ready' || (states.get('model').phase === 'unsupported' && latest.stage === 'generate' && !latest.keywordOnly);
  }
  function createRow(conversation: Conversation, turn: ChatTurn): Row {
    const root = element('article', 'chat-turn'); root.setAttribute('aria-label', 'Question and reply');
    const user = element('div', 'chat-user'); user.append(element('span', 'chat-speaker', 'You'), element('p', '', turn.question));
    const assistant = element('div', 'chat-assistant');
    const thinking = element('details', 'chat-thinking');
    const thinkingSummary = element('summary', '', 'Thinking…');
    const thinkingText = element('p', 'chat-thinking-text');
    thinking.append(thinkingSummary, thinkingText);
    const answer = element('p', 'llm-answer');
    const status = element('p', 'chat-turn-status'); status.setAttribute('role', 'status');
    const context = element('p', 'chat-context');
    const sources = element('details', 'chat-sources');
    const copy = element('button', '', 'Copy'); copy.type = 'button';
    const retry = element('button', '', 'Retry'); retry.type = 'button'; retry.onclick = () => { void controller.retry(); };
    const feedback = element('span', 'action-feedback'); feedback.setAttribute('role', 'status');
    copy.onclick = async () => {
      const current = store.get(conversation.id)?.turns.find(value => value.id === turn.id);
      if (!current) return;
      try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(current.answer); feedback.textContent = 'Copied'; }
      catch { feedback.textContent = 'Could not copy. Select the answer text to copy.'; }
      setTimeout(() => { if (rows.get(turn.id)?.feedback === feedback) feedback.textContent = ''; }, 3000);
    };
    answer.onclick = event => {
      const link = (event.target as Element).closest('a');
      if (!link) return;
      const target = document.getElementById(link.hash.slice(1));
      if (target) { event.preventDefault(); sources.open = true; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
    };
    const actions = element('div', 'chat-answer-actions'); actions.append(copy, retry, feedback);
    assistant.append(element('span', 'chat-speaker', 'RAGbox'), thinking, answer, status, context, sources, actions);
    root.append(user, assistant); transcript.append(root);
    return { root, answer, thinking, thinkingSummary, thinkingText, status, context, sources, copy, retry, feedback };
  }
  function renderRow(conversation: Conversation, turn: ChatTurn, latest: boolean) {
    let row = rows.get(turn.id);
    if (!row) { row = createRow(conversation, turn); rows.set(turn.id, row); }
    if (row.turn === turn && row.latest === latest) return;
    row.turn = turn; row.latest = latest;
    const answerKey = `${turn.answer}\0${turn.includedIds.join('\0')}`;
    if (row.answerKey !== answerKey) {
      const included = new Set(turn.includedIds);
      renderAnswer(row.answer, turn.answer, new Map(turn.results.filter(document => included.has(document.id)).map(document => [document.id, `#${sourceAnchor(conversation.id, turn.id, document.id)}`])));
      row.answerKey = answerKey;
    }
    row.answer.hidden = !turn.answer;
    row.thinking.hidden = !turn.thinking && turn.phase !== 'generating';
    row.thinkingSummary.textContent = turn.phase === 'generating' && !turn.answer ? 'Thinking…' : turn.phase === 'stopped' ? 'Reasoning (stopped)' : 'Reasoning';
    if (row.thinkingText.textContent !== (turn.thinking ?? '')) row.thinkingText.textContent = turn.thinking ?? '';
    row.status.textContent = turn.message;
    // The Thinking box already says "Thinking…"; don't repeat it as a status line.
    const repeatsThinking = !row.thinking.hidden && turn.message === row.thinkingSummary.textContent;
    row.status.hidden = (turn.phase === 'complete' && !turn.keywordOnly) || repeatsThinking;
    row.root.dataset.phase = turn.phase;
    row.context.hidden = !turn.contextLimited;
    row.context.textContent = 'Using up to the latest 3 turns, within the model’s context limit. Earlier messages remain saved.';
    row.copy.disabled = !turn.answer.trim(); row.copy.hidden = !turn.answer.trim();
    row.retry.hidden = !latest || !['error', 'stopped', 'blocked'].includes(turn.phase);
    row.retry.disabled = controller.running || states.busy || states.get(conversation.corpus).phase !== 'ready' || (states.get('model').phase === 'unsupported' && turn.stage === 'generate' && !turn.keywordOnly);
    row.retry.textContent = turn.phase === 'blocked' ? 'Retry answer' : 'Retry';
    row.sources.hidden = !turn.results.length;
    if (row.results !== turn.results) {
      const summary = element('summary', '', `Sources (${turn.results.length})`);
      const metadata = element('p', 'chat-source-query'); row.metadata = metadata;
      const list = element('ol');
      for (const result of turn.results) {
        const item = element('li'); item.id = sourceAnchor(conversation.id, turn.id, result.id); item.tabIndex = -1;
        const full = element('details'); full.append(element('summary', '', 'Full document text'), element('p', 'chat-source-text', result.text));
        item.append(element('h3', '', result.title), element('p', 'chat-source-meta', `${result.id} · BM25 ${result.score.toFixed(4)}`), element('p', '', result.text.slice(0, 350) + (result.text.length > 350 ? '…' : '')), full);
        list.append(item);
      }
      row.sources.replaceChildren(summary, metadata, list); row.results = turn.results;
    }
    if (row.metadata) row.metadata.textContent = `${turn.keywordOnly ? 'Keyword search' : 'Search'}: ${turn.searchQuery ?? turn.question}${turn.elapsedMs == null ? '' : ` · ${turn.elapsedMs.toFixed(0)} ms`}`;
  }
  function render() {
    const conversation = store.current();
    const changed = conversationId !== conversation.id;
    const scrollTop = window.scrollY;
    const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 160;
    if (changed) { rows.clear(); transcript.replaceChildren(); conversationId = conversation.id; }
    title.textContent = conversation.turns.length ? conversation.title : 'Ask your documents';
    empty.hidden = !!conversation.turns.length; dashboard.hidden = !!conversation.turns.length;
    for (const [index, turn] of conversation.turns.entries()) renderRow(conversation, turn, index === conversation.turns.length - 1);
    // Only transcript updates in the visible chat may move the scroll position.
    if (!changed && nearBottom && !requiredElement<HTMLElement>('#search-view').hidden && conversation.turns.length) {
      requestAnimationFrame(() => {
        if (!disposed && store.current().id === conversation.id && !requiredElement<HTMLElement>('#search-view').hidden && window.scrollY === scrollTop) {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        }
      });
    }
  }
  function renderComposer() {
    const changed = draftConversationId !== store.current().id;
    draftConversationId = store.current().id;
    if (changed || document.activeElement !== query) {
      if (query.value !== store.draft()) { query.value = store.draft(); resize(); }
    }
    renderControls();
  }
  modelStatus.setAttribute('aria-live', 'off');
  const unsubscribers = [
    store.watch(currentConversation, render, true),
    store.watch(state => [currentConversation(state).id, currentDraft(state), state.thinkingEffort, state.initialized, state.activeOperation, currentConversation(state).turns.at(-1)?.phase], renderComposer, true),
    store.watch(state => state.unsaved, message => { unsaved.textContent = message; unsaved.hidden = !message; }, true),
    store.watch(state => state.selected, selected => {
      if (exampleCorpus === selected) return;
      exampleCorpus = selected;
      examples.replaceChildren(...EXAMPLE_QUERIES[selected].map(question => {
        const button = element('button', 'chat-example', question); button.type = 'button';
        button.onclick = () => { query.value = question; store.setDraft(question); resize(); if (controller.canSend()) submit(); else query.focus(); };
        return button;
      }));
    }, true),
    states.watch(state => [state.busy, state.shuttingDown, state.resources.nfcorpus.phase, state.resources.msmarco.phase, state.resources.model.phase === 'unsupported'], renderControls),
  ];
  resize();
  return { render, dispose() {
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener('resize', resize);
    form.onsubmit = null; query.oninput = null; query.onkeydown = null; effort.onchange = null;
  } };
}

export function matchesConversation(conversation: Conversation, filter: string) {
  const text = [conversation.title, conversation.corpus === 'msmarco' ? 'MS MARCO' : 'NFCorpus', ...conversation.turns.flatMap(turn => [turn.question, turn.answer, ...turn.results.map(result => result.title)])].join(' ').toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

export function setupConversationHistory(controller: ChatController, open: (conversation: Conversation) => void) {
  const list = requiredElement<HTMLOListElement>('#history-list');
  const filter = requiredElement<HTMLInputElement>('#history-filter');
  const count = requiredElement<HTMLElement>('#history-count');
  const clear = requiredElement<HTMLButtonElement>('#history-clear');
  const tools = requiredElement<HTMLElement>('#history-tools');
  const empty = requiredElement<HTMLElement>('#history-empty');
  const noMatch = requiredElement<HTMLElement>('#history-no-match');
  const cards = new Map<string, { root: HTMLLIElement; title: HTMLElement; meta: HTMLElement; preview: HTMLElement; conversation?: Conversation; filter?: string }>();
  function render() {
    const conversations = controller.store.conversations();
    const ids = new Set(conversations.map(conversation => conversation.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.root.remove(); cards.delete(id); }
    let shown = 0;
    for (const [index, conversation] of conversations.entries()) {
      let card = cards.get(conversation.id);
      if (!card) {
        const root = document.createElement('li'); root.className = 'conversation-card';
        const title = document.createElement('h2'); const meta = document.createElement('p'); meta.className = 'history-result-meta';
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View conversation';
        const preview = document.createElement('div'); preview.className = 'conversation-preview'; details.append(summary, preview);
        const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Continue chat';
        resume.onclick = () => { const current = controller.store.get(conversation.id); if (current) open(current); };
        root.append(title, meta, resume, details); card = { root, title, meta, preview }; cards.set(conversation.id, card);
      }
      if (card.conversation !== conversation) {
        card.title.textContent = conversation.title;
        card.meta.textContent = `${conversation.corpus === 'msmarco' ? 'MS MARCO' : 'NFCorpus'} · ${conversation.turns.length} ${conversation.turns.length === 1 ? 'turn' : 'turns'} · ${new Date(conversation.updatedAt).toLocaleString()}`;
        card.preview.textContent = conversation.turns.map(turn => `You: ${turn.question}\nRAGbox: ${turn.answer || turn.message}${turn.phase === 'stopped' ? ' (Stopped)' : ''}`).join('\n\n');
      }
      if (card.conversation !== conversation || card.filter !== filter.value) card.root.hidden = !matchesConversation(conversation, filter.value);
      card.conversation = conversation; card.filter = filter.value;
      if (!card.root.hidden) shown++;
      if (list.children[index] !== card.root) list.insertBefore(card.root, list.children[index] ?? null);
    }
    empty.hidden = !!conversations.length; tools.hidden = !conversations.length; clear.hidden = !conversations.length;
    count.textContent = `${filter.value ? `${shown} of ` : ''}${conversations.length} ${conversations.length === 1 ? 'conversation' : 'conversations'}`;
    noMatch.hidden = !conversations.length || shown > 0; noMatch.textContent = `No conversations match “${filter.value}”.`;
  }
  filter.oninput = render;
  clear.onclick = () => {
    if (confirm('Clear all conversations in this browser?')) {
      filter.value = '';
      void controller.clear().then(() => open(controller.store.current()));
    }
  };
  const unsubscribe = controller.store.watch(state => state.items, render, true);
  return { dispose() { unsubscribe(); filter.oninput = null; clear.onclick = null; } };
}
