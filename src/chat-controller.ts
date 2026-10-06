import type { ChatMessage, ChatOperation, ChatTurn, Corpus, RetrievalResult, TurnStage } from './types.ts';
import type { ModelService } from './model-service.ts';
import { ConversationStore } from './conversations.ts';
import { extractCitations, INSUFFICIENT_EVIDENCE } from './rag.ts';
import { errorMessage } from './errors.ts';

export type ChatModel = Pick<ModelService, 'ready' | 'state' | 'model' | 'subscribe' | 'resolveQuery' | 'generateAnswer'>;
interface Attempt extends ChatOperation { abort: AbortController }
export interface ChatResources {
  ready(corpus: Corpus): boolean;
  busy(): boolean;
  retrieve(corpus: Corpus, query: string, operation: ChatOperation): Promise<RetrievalResult>;
}

export function conversationHistory(turns: ChatTurn[]): ChatMessage[] {
  return turns.slice(-3).flatMap(turn => [
    { role: 'user' as const, content: turn.question },
    ...(turn.phase === 'complete' && turn.answer ? [{ role: 'assistant' as const, content: turn.answer }] : []),
  ]);
}

export class ChatController {
  private active?: Attempt;
  private pending?: { conversationId: string; turnId: string };
  private sequence = 0;
  private unsubscribe: () => void;
  constructor(readonly store: ConversationStore, private model: ChatModel, private resources: ChatResources) {
    this.unsubscribe = model.subscribe(() => this.resumePending());
  }
  get running() { return !!this.active || this.store.current().turns.at(-1)?.phase === 'waiting'; }
  canSend() { return this.store.initialized && this.resources.ready(this.store.selected) && !this.resources.busy() && !this.running; }
  async send(question: string) {
    question = question.trim();
    if (!question || question.length > 500 || !this.canSend()) return;
    this.pending = undefined;
    const conversation = this.store.current();
    const turn = this.store.append(question, conversationHistory(conversation.turns), conversation.turns.length > 3);
    await this.process(conversation.id, turn.id, turn.stage);
  }
  private valid(attempt: Attempt) {
    return this.active === attempt && !attempt.abort.signal.aborted && this.store.current().id === attempt.conversationId;
  }
  private turn(attempt: Attempt) { return this.store.get(attempt.conversationId)?.turns.find(turn => turn.id === attempt.turnId); }
  private update(attempt: Attempt, changes: Partial<ChatTurn>, streaming = false) {
    if (this.valid(attempt)) this.store.update(attempt.conversationId, attempt.turnId, changes, streaming);
  }
  private async process(conversationId: string, turnId: string, stage: TurnStage) {
    if (this.active || this.resources.busy()) return;
    const conversation = this.store.get(conversationId);
    if (!conversation || !this.resources.ready(conversation.corpus)) return;
    const operation: ChatOperation = { conversationId, turnId, attemptId: `attempt-${++this.sequence}` };
    const attempt: Attempt = { ...operation, abort: new AbortController() };
    this.active = attempt; this.pending = undefined;
    const turn = this.turn(attempt);
    if (!turn) { this.active = undefined; return; }
    const history = turn.history;
    let query = turn.searchQuery ?? turn.question;
    let keywordOnly = turn.keywordOnly === true;
    try {
      const resolve = async () => {
        this.update(attempt, { phase: 'resolving', stage: 'resolve', message: 'Understanding your follow-up…', answer: '', includedIds: [], citedIds: [] });
        const resolved = await this.model.resolveQuery(turn.question, history, attempt.abort.signal, operation);
        if (!this.valid(attempt)) return;
        query = resolved.query; keywordOnly = false;
        this.update(attempt, { searchQuery: query, keywordOnly: false, contextLimited: turn.contextLimited || resolved.contextLimited });
      };
      const retrieve = async () => {
        this.update(attempt, { phase: 'retrieving', stage: 'retrieve', searchQuery: query, keywordOnly, message: keywordOnly ? 'Searching literal keywords…' : 'Searching documents…', answer: '', includedIds: [], citedIds: [] });
        const result = await this.resources.retrieve(conversation.corpus, query, operation);
        this.update(attempt, { results: result.documents, elapsedMs: result.elapsedMs });
      };
      if (stage !== 'generate') {
        if (stage === 'resolve' && history.length && this.model.ready) await resolve();
        else if (stage === 'resolve') { query = turn.question; keywordOnly = !this.model.ready; }
        else keywordOnly = keywordOnly || !this.model.ready;
        if (!this.valid(attempt)) return;
        await retrieve();
      }
      if (!this.valid(attempt)) return;
      // The model may finish loading while a literal search is in progress.
      if (keywordOnly && history.length && this.model.ready) { await resolve(); if (this.valid(attempt)) await retrieve(); }
      if (!this.valid(attempt)) return;
      const retrieved = this.turn(attempt)!;
      if (!this.model.ready) {
        const waiting = this.model.state === 'checking' || this.model.state === 'loading';
        if (!retrieved.results.length && !history.length) {
          this.update(attempt, { phase: 'complete', stage: 'generate', answer: INSUFFICIENT_EVIDENCE, message: 'No matching documents.', keywordOnly });
        } else {
          this.pending = { conversationId, turnId };
          this.update(attempt, { phase: waiting ? 'waiting' : 'blocked', stage: 'generate', keywordOnly,
            message: `${waiting ? 'Waiting for the model.' : 'AI answers are unavailable.'} ${keywordOnly ? 'Showing keyword search results; contextual follow-ups require the model.' : 'Retrieved sources are available; load the model to finish this answer.'}` });
        }
        return;
      }
      if (!retrieved.results.length) {
        this.update(attempt, { phase: 'complete', stage: 'generate', answer: INSUFFICIENT_EVIDENCE, message: 'No matching documents.', keywordOnly: false });
        return;
      }
      this.update(attempt, { phase: 'generating', stage: 'generate', keywordOnly: false, answer: '', thinking: '', includedIds: [], citedIds: [], message: 'Thinking…' });
      const answer = await this.model.generateAnswer({
        corpus: conversation.corpus, question: turn.question, searchQuery: query, documents: retrieved.results, history, thinkingEffort: turn.thinkingEffort, operation,
        citationTargets: new Map(retrieved.results.map(document => [document.id, document.id])),
        onContext: (ids, limited) => this.update(attempt, { includedIds: ids, contextLimited: turn.contextLimited || limited }),
        onAnswerReset: () => this.update(attempt, { answer: '', citedIds: [], message: 'Checking citations…' }),
        onThinkingDelta: text => {
          if (!this.valid(attempt)) return;
          const current = this.turn(attempt)!;
          this.update(attempt, { thinking: (current.thinking ?? '') + text }, true);
        },
        onDelta: text => {
          if (!this.valid(attempt)) return;
          const current = this.turn(attempt)!;
          const answer = current.answer + text;
          this.update(attempt, { answer, message: 'Writing a cited answer…', citedIds: extractCitations(answer, current.includedIds) }, true);
        },
      }, attempt.abort.signal);
      if (!this.valid(attempt)) return;
      this.update(attempt, { phase: 'complete', answer: answer.answer, thinking: answer.thinking ?? this.turn(attempt)?.thinking, includedIds: answer.documentIds,
        citedIds: extractCitations(answer.answer, answer.documentIds), message: 'Answer complete.' });
    } catch (error) {
      if (this.valid(attempt)) this.update(attempt, { phase: 'error', message: errorMessage(error) });
    } finally {
      if (this.active === attempt) this.active = undefined;
      this.store.notify();
      this.resumePending();
    }
  }
  resumePending() {
    const pending = this.pending;
    if (pending && !this.active && !this.model.ready && !['checking', 'loading'].includes(this.model.state)) {
      const turn = this.store.get(pending.conversationId)?.turns.find(turn => turn.id === pending.turnId);
      if (turn?.phase === 'waiting') this.store.update(pending.conversationId, pending.turnId, { phase: 'blocked', message: 'The model could not load. Keyword results are available; use the model recovery action to retry.' });
    }
    if (!pending || this.active || !this.model.ready || this.resources.busy() || this.store.current().id !== pending.conversationId) return;
    const conversation = this.store.current();
    const turn = conversation.turns.at(-1);
    if (!turn || turn.id !== pending.turnId || !this.resources.ready(conversation.corpus)) return;
    this.pending = undefined;
    void this.process(conversation.id, turn.id, turn.history.length && turn.keywordOnly ? 'resolve' : 'generate');
  }
  stop() {
    const target = this.active ?? this.pending;
    this.pending = undefined;
    const attempt = this.active; this.active = undefined;
    if (target) {
      const turn = this.store.get(target.conversationId)?.turns.find(turn => turn.id === target.turnId);
      if (turn) this.store.update(target.conversationId, target.turnId, { phase: 'stopped', message: 'Stopped', citedIds: extractCitations(turn.answer, turn.includedIds) });
    }
    attempt?.abort.abort(); this.store.notify();
  }
  async retry() {
    if (this.running || this.resources.busy()) return;
    const conversation = this.store.current();
    const turn = conversation.turns.at(-1);
    if (!turn || !this.resources.ready(conversation.corpus)) return;
    await this.process(conversation.id, turn.id, turn.keywordOnly && turn.history.length ? 'resolve' : turn.stage === 'generate' && !turn.results.length ? 'retrieve' : turn.stage);
  }
  select(corpus: Corpus) { if (this.store.selected !== corpus) this.stop(); this.store.select(corpus); }
  newChat() { this.stop(); this.store.newChat(); }
  open(conversationId: string) { this.stop(); this.store.open(conversationId); }
  async clear() { this.stop(); await this.store.clear(); }
  dispose() { this.stop(); this.unsubscribe(); }
}
