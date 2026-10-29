import { requiredElement } from './boundaries.ts';
import { renderAnswer } from './llm-controller.ts';
import { EXAMPLE_QUERIES } from './example-queries.ts';
import { MAX_QUESTION_LENGTH, type ChatController } from './chat-controller.ts';
import type { ResourceStates } from './resource-state.ts';
import type { ChatTurn, Conversation } from './types.ts';
import { currentConversation, currentDraft } from './conversations.ts';
import { ArrowUp, Check, Copy, Square } from 'lucide';
import { appIcon } from './icons.ts';

export function sourceAnchor(conversationId: string, turnId: string, documentId: string) {
  return `chat-source-${encodeURIComponent(conversationId)}-${encodeURIComponent(turnId)}-${encodeURIComponent(documentId)}`;
}
export function handleComposerKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'preventDefault'>, send: () => void) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
}

export function setupChatView(controller: ChatController, states: ResourceStates) {
  const { store } = controller;
  const form = requiredElement<HTMLFormElement>('#chat-form');
  const query = requiredElement<HTMLTextAreaElement>('#chat-query');
  const send = requiredElement<HTMLButtonElement>('#chat-send');
  const lengthWarning = requiredElement<HTMLElement>('#chat-length-warning');
  const transcript = requiredElement<HTMLElement>('#chat-transcript');
  const title = requiredElement<HTMLElement>('#chat-title');
  const empty = requiredElement<HTMLElement>('#chat-empty');
  const examples = requiredElement<HTMLElement>('#chat-examples');
  const suggestions = requiredElement<HTMLUListElement>('#chat-suggestions');
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
    if (form.offsetHeight) {
      workspace.style.paddingBottom = `${form.offsetHeight + 20}px`;
      // Lets the latest exchange fill the screen above the composer (see .chat-turn:last-child).
      workspace.style.setProperty('--composer-space', `${form.offsetHeight + 20}px`);
    }
  };
  window.addEventListener('resize', resize);
  // Offer the full-text toggle only for sources whose text runs past the three-line clamp.
  const fitSources = (root: ParentNode) => {
    for (const text of root.querySelectorAll<HTMLElement>('.chat-sources[open] li:not([data-expanded]) .chat-source-text')) {
      (text.nextElementSibling as HTMLElement).hidden = text.scrollHeight <= text.clientHeight + 1;
    }
  };
  const refitSources = () => fitSources(transcript);
  window.addEventListener('resize', refitSources);
  // Readiness messages inside the pinned composer change its height without input.
  const composerObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
  composerObserver?.observe(form);
  const submit = () => {
    if (!controller.canSend() || !query.value.trim() || tooLong()) return;
    const question = query.value; query.value = ''; store.setDraft(''); resize();
    void controller.send(question);
  };
  form.onsubmit = event => { event.preventDefault(); if (controller.running) controller.stop(); else submit(); };
  // Starter questions also drop up from the search box during a chat, so they stay
  // one click away without going back to the start page.
  let suggestion = -1;
  const suggestionItems = () => Array.from(suggestions.children) as HTMLElement[];
  function highlightSuggestion(index: number) {
    suggestion = index;
    suggestionItems().forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) query.setAttribute('aria-activedescendant', suggestionItems()[index].id);
    else query.removeAttribute('aria-activedescendant');
  }
  function setSuggestionsOpen(open: boolean) {
    const show = open && !!store.current().turns.length && !query.value.trim() && suggestionItems().length > 0;
    suggestions.hidden = !show;
    query.setAttribute('aria-expanded', String(show));
    if (!show) highlightSuggestion(-1);
  }
  function chooseExample(question: string) {
    setSuggestionsOpen(false);
    query.value = question; store.setDraft(question); resize();
    if (controller.canSend()) submit(); else query.focus();
  }
  query.onkeydown = event => {
    const items = suggestionItems();
    if (suggestions.hidden && event.key === 'ArrowDown' && !query.value.trim()) setSuggestionsOpen(true);
    if (!suggestions.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlightSuggestion(suggestion < 0 ? (step > 0 ? 0 : items.length - 1) : (suggestion + step + items.length) % items.length);
    } else if (!suggestions.hidden && event.key === 'Escape') {
      event.preventDefault(); setSuggestionsOpen(false);
    } else if (!suggestions.hidden && event.key === 'Enter' && suggestion >= 0 && !event.shiftKey) {
      event.preventDefault(); chooseExample(items[suggestion].textContent ?? '');
    } else handleComposerKey(event, submit);
  };
  // The box keeps focus after sending, so a later click raises no focus event; open on click too.
  query.onfocus = () => setSuggestionsOpen(true);
  query.onclick = () => { if (suggestions.hidden) setSuggestionsOpen(true); };
  query.onblur = () => setSuggestionsOpen(false);
  query.oninput = () => { store.setDraft(query.value); resize(); renderControls(); setSuggestionsOpen(true); };
  requiredElement<HTMLButtonElement>('#chat-new').onclick = () => { controller.newChat(); query.focus(); };

  const tooLong = () => query.value.trim().length > MAX_QUESTION_LENGTH;
  function renderControls() {
    const length = query.value.trim().length;
    lengthWarning.hidden = !tooLong();
    lengthWarning.textContent = tooLong()
      ? `Your question is ${length} characters. Shorten it to ${MAX_QUESTION_LENGTH} or fewer to send.`
      : '';
    query.toggleAttribute('aria-invalid', tooLong());
    const mode = controller.running ? 'stop' : 'send';
    if (send.dataset.mode !== mode) {
      send.dataset.mode = mode;
      send.replaceChildren(mode === 'stop'
        ? appIcon(Square, 16, { fill: 'currentColor', 'stroke-width': 0 })
        : appIcon(ArrowUp, 20, { 'stroke-width': 2.2 }));
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
    sources.ontoggle = () => fitSources(sources);
    // Icon-only copy button beside the answer it copies.
    const copy = element('button', 'chat-copy'); copy.type = 'button';
    const showCopyIcon = (copied: boolean) => {
      copy.replaceChildren(appIcon(copied ? Check : Copy, 16, { 'stroke-width': copied ? 2.2 : 1.8 }));
      copy.title = copied ? 'Copied' : 'Copy answer';
      copy.setAttribute('aria-label', copied ? 'Answer copied' : 'Copy answer');
    };
    showCopyIcon(false);
    const retry = element('button', '', 'Retry'); retry.type = 'button'; retry.onclick = () => { void controller.retry(); };
    const feedback = element('span', 'action-feedback'); feedback.setAttribute('role', 'status');
    copy.onclick = async () => {
      const current = store.get(conversation.id)?.turns.find(value => value.id === turn.id);
      if (!current) return;
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(current.answer);
        feedback.textContent = 'Copied'; showCopyIcon(true);
      } catch { feedback.textContent = 'Could not copy. Select the answer text to copy.'; }
      setTimeout(() => { if (rows.get(turn.id)?.feedback === feedback) { feedback.textContent = ''; showCopyIcon(false); } }, 2000);
    };
    answer.onclick = event => {
      const link = (event.target as Element).closest('a');
      if (!link) return;
      const target = document.getElementById(link.hash.slice(1));
      if (target) { event.preventDefault(); sources.open = true; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
    };
    const answerBlock = element('div', 'chat-answer-block'); answerBlock.append(answer, copy, feedback);
    const actions = element('div', 'chat-answer-actions'); actions.append(retry);
    assistant.append(element('span', 'chat-speaker', 'RAGbox'), thinking, answerBlock, status, context, sources, actions);
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
    // Thinking Off produces no reasoning, so only show the box when reasoning can exist.
    row.thinking.hidden = !turn.thinking && (turn.phase !== 'generating' || turn.thinkingEffort === 'off');
    row.thinkingSummary.textContent = turn.phase === 'generating' && !turn.answer ? 'Thinking…' : turn.phase === 'stopped' ? 'Reasoning (stopped)' : 'Reasoning';
    if (row.thinkingText.textContent !== (turn.thinking ?? '')) row.thinkingText.textContent = turn.thinking ?? '';
    row.status.textContent = turn.message;
    // The Thinking box already says "Thinking…"; don't repeat it as a status line.
    const repeatsThinking = !row.thinking.hidden && turn.message === row.thinkingSummary.textContent;
    row.status.hidden = (turn.phase === 'complete' && !turn.keywordOnly) || repeatsThinking;
    row.root.dataset.phase = turn.phase;
    // Drives the in-progress animations: dots, search sweep, glowing bulb, or typing caret.
    row.root.dataset.activity = turn.phase === 'resolving' ? 'resolving'
      : turn.phase === 'retrieving' ? 'searching'
      : turn.phase !== 'generating' ? ''
      : turn.answer ? 'writing'
      : turn.thinkingEffort === 'off' ? 'preparing' : 'thinking';
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
        const more = element('button', 'chat-source-more', 'Display full text'); more.type = 'button'; more.hidden = true; more.setAttribute('aria-expanded', 'false');
        more.onclick = () => {
          const expanded = item.toggleAttribute('data-expanded');
          more.textContent = expanded ? 'Show less' : 'Display full text'; more.setAttribute('aria-expanded', String(expanded));
        };
        item.append(element('h3', '', result.title), element('p', 'chat-source-meta', `${result.title === result.id ? '' : `${result.id} · `}BM25 ${result.score.toFixed(4)}`), element('p', 'chat-source-text', result.text), more);
        list.append(item);
      }
      row.sources.replaceChildren(summary, metadata, list); row.results = turn.results;
      fitSources(row.sources);
    }
    if (row.metadata) row.metadata.textContent = `${turn.keywordOnly ? 'Keyword search' : 'Search'}: ${turn.searchQuery ?? turn.question}${turn.elapsedMs == null ? '' : ` · ${turn.elapsedMs.toFixed(0)} ms`}`;
  }
  function render() {
    const conversation = store.current();
    const changed = conversationId !== conversation.id;
    const latest = conversation.turns.at(-1);
    const asked = !changed && !!latest && !rows.has(latest.id);
    if (changed) { rows.clear(); transcript.replaceChildren(); conversationId = conversation.id; }
    title.textContent = conversation.turns.length ? conversation.title : 'Ask your documents';
    empty.hidden = !!conversation.turns.length; dashboard.hidden = !!conversation.turns.length;
    for (const [index, turn] of conversation.turns.entries()) renderRow(conversation, turn, index === conversation.turns.length - 1);
    // A newly asked question scrolls to the top of the screen with its reply below. Streaming
    // never moves the page afterwards, so readers can scroll freely through earlier turns.
    if (asked && latest && !requiredElement<HTMLElement>('#search-view').hidden) {
      const row = rows.get(latest.id)!;
      requestAnimationFrame(() => {
        if (disposed || store.current().id !== conversation.id || requiredElement<HTMLElement>('#search-view').hidden) return;
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (conversation.turns.length === 1) window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
        else row.root.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
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
        button.onclick = () => chooseExample(question);
        return button;
      }));
      suggestions.replaceChildren(...EXAMPLE_QUERIES[selected].map((question, index) => {
        const item = element('li', 'example-query', question);
        item.id = `chat-suggestion-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false');
        // Keep focus in the search box so choosing does not close the list first.
        item.onmousedown = event => event.preventDefault();
        item.onclick = () => chooseExample(question);
        return item;
      }));
      setSuggestionsOpen(false);
    }, true),
    states.watch(state => [state.busy, state.shuttingDown, state.resources.nfcorpus.phase, state.resources.msmarco.phase, state.resources.model.phase === 'unsupported'], renderControls),
  ];
  resize();
  return { render, dispose() {
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener('resize', resize);
    window.removeEventListener('resize', refitSources);
    composerObserver?.disconnect();
    form.onsubmit = null; query.oninput = null; query.onkeydown = null; query.onfocus = null; query.onclick = null; query.onblur = null;
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
