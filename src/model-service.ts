import { errorMessage } from './errors.ts';
import type { ChatMessage, ChatOperation, Corpus, EvidenceDocument, ModelCacheAvailability, ModelStatus, WorkerRequest, WorkerResponse } from './types.ts';
import { inspectModelCache } from './model-readiness.ts';
import { formatBytes } from './format.ts';
import type { LoadCoordinator } from './load-coordinator.ts';
export type Capability = { supported: true } | { supported: false; reason: string };
export type CitationTargets = Map<string, string> | Record<string, string>;
interface AnswerSession {
  options: GenerateOptions;
  text: string;
  thinking?: string;
  targets: Map<string, string>;
  phase: 'waiting' | 'generating' | 'complete' | 'stopped' | 'error' | 'blocked';
  message: string;
}

interface ActiveRequest {
  id: string;
  corpus: Corpus;
  answerText: string;
  citationTargets: Map<string, string>;
  includedTargets: Map<string, string>;
  evidenceLabel: string;
  onComplete?: (answer: string, citedIds: string[]) => void;
  session: AnswerSession;
}

export type ControllerState = 'checking' | 'unsupported' | 'idle' | 'loading' | 'ready' | 'generating' | 'error';

export interface GenerateOptions {
  corpus: Corpus;
  question: string;
  documents: EvidenceDocument[];
  citationTargets: CitationTargets;
  evidenceLabel?: string;
  searchToken?: number;
  history?: ChatMessage[];
  searchQuery?: string;
  operation?: ChatOperation;
  onDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onContext?: (ids: string[], limited: boolean) => void;
  onError?: (error: Error) => void;
  onStopped?: (answer: string, citedIds: string[]) => void;
  onCancelled?: () => void;
  // Called once with the final answer and the evidence IDs it cites.
  onComplete?: (answer: string, citedIds: string[]) => void;
}

export async function detectWebGPU(): Promise<Capability> {
  if (!globalThis.navigator?.gpu) {
    return { supported: false, reason: 'WebGPU is unavailable in this browser.' };
  }
  const adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { supported: false, reason: 'No WebGPU adapter is available.' };
  if (!adapter.features.has('shader-f16')) {
    return { supported: false, reason: 'This GPU does not expose the shader-f16 feature required by the model.' };
  }
  return { supported: true };
}

function defaultWorkerFactory() {
  return new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' });
}

export function citationTargetMap(citationTargets?: CitationTargets): Map<string, string> {
  if (citationTargets instanceof Map) {
    return new Map([...citationTargets].map(([id, target]) => [String(id), String(target)]));
  }
  return new Map(Object.entries(citationTargets ?? {}).map(([id, target]) => [String(id), String(target)]));
}

const CITATION = /\[([A-Za-z0-9_.:-]+)\]/g;

export function citedIds(text: string, available: Map<string, string>): string[] {
  return [...new Set([...text.matchAll(CITATION)].map(match => match[1]))].filter(id => available.has(id));
}

export class ModelService {
  private workerFactory: () => Worker;
  private capabilityDetector: () => Promise<Capability>;
  private cacheInspector: () => Promise<ModelCacheAvailability>;
  private capabilityPromise?: Promise<Capability>;
  private worker: Worker | null = null;
  private capability: Capability | null = null;
  private loads?: LoadCoordinator;
  private onState?: (state: ControllerState, message: string, model: ModelStatus) => void;
  private loadWaiters = new Set<() => void>();
  private loadNumber = 0;
  private activeLoad?: number;
  private requestNumber = 0;
  private searchNumber = 0;
  protected sessions = new Map<Corpus, AnswerSession>();
  protected retrievalMessages = new Map<Corpus, string>();
  protected pending: AnswerSession | null = null;
  private feedbackTimers = new Map<Corpus, ReturnType<typeof setTimeout>>();
  private onLoadSettled?: () => void;
  private resolution?: { id: string; resolve: (result: { query: string; contextLimited: boolean }) => void; reject: (error: Error) => void };
  state: ControllerState = 'checking';
  activeRequest: ActiveRequest | null = null;
  repairNeeded = false;
  model: ModelStatus = { cache: 'checking', stage: 'checking', downloadedBytes: 0 };

  constructor({ workerFactory = defaultWorkerFactory, detectWebGPU: capabilityDetector = detectWebGPU,
    inspectCache = async () => (await inspectModelCache()).availability, onState, loads,
  }: { workerFactory?: () => Worker; detectWebGPU?: () => Promise<Capability>;
    inspectCache?: () => Promise<ModelCacheAvailability>;
    onState?: (state: ControllerState, message: string, model: ModelStatus) => void; loads?: LoadCoordinator } = {}) {
    this.workerFactory = workerFactory;
    this.capabilityDetector = capabilityDetector;
    this.cacheInspector = inspectCache;
    this.onState = onState;
    this.loads = loads;
  }

  protected renderSession(_corpus: Corpus, _text: string, _targets: Map<string, string> = new Map()) {}
  protected setFeedback(_corpus: Corpus, _message: string) {}
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  get ready() { return this.state === 'ready' || this.state === 'generating'; }

  resolveQuery(question: string, history: ChatMessage[], signal: AbortSignal, operation?: ChatOperation): Promise<{ query: string; contextLimited: boolean }> {
    if (!this.ready || signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    this.cancel(true);
    const id = `resolve-${++this.requestNumber}`;
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.resolution?.id === id) this.cancel(true); };
      const finish = <T>(callback: (value: T) => void, value: T) => { signal.removeEventListener('abort', abort); callback(value); };
      this.resolution = { id, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      signal.addEventListener('abort', abort, { once: true });
      this.state = 'generating';
      this.updateControls();
      try { this.ensureWorker().postMessage({ type: 'resolve-query', requestId: id, question, history, operation } satisfies WorkerRequest); }
      catch (error) { this.handleMessage({ type: 'error', operation: 'resolve-query', requestId: id, message: errorMessage(error) }); }
    });
  }

  generateAnswer(options: Omit<GenerateOptions, 'onComplete' | 'onStopped' | 'onCancelled' | 'onError'>, signal: AbortSignal): Promise<{ answer: string; thinking?: string; documentIds: string[] }> {
    if (!this.ready || signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      const abort = () => { this.cancel(true); finish(reject, new DOMException('Cancelled', 'AbortError')); };
      const finish = <T>(callback: (value: T) => void, value: T) => { signal.removeEventListener('abort', abort); callback(value); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.generate({ ...options,
          onComplete: answer => {
            const session = this.sessions.get(options.corpus);
            finish(resolve, { answer, ...(session?.thinking ? { thinking: session.thinking } : {}), documentIds: [...(session?.targets.keys() ?? [])] });
          },
          onStopped: () => finish(reject, new DOMException('Cancelled', 'AbortError')),
          onCancelled: () => finish(reject, new DOMException('Cancelled', 'AbortError')),
          onError: error => finish(reject, error),
        });
      } catch (error) {
        finish(reject, new Error(errorMessage(error)));
        this.cancel(true);
      }
    });
  }

  setOnLoadSettled(callback: () => void) { this.onLoadSettled = callback; }

  setCacheAvailability(cache: ModelCacheAvailability) {
    this.model.cache = cache;
    this.repairNeeded = cache === 'corrupt';
    this.updateControls();
  }

  loadAction() {
    if (this.model.cache === 'missing') return 'Download model (~1.84 GB)';
    if (this.model.cache === 'incomplete' || this.model.cache === 'corrupt') return 'Download missing files';
    return this.state === 'error' || this.model.failure ? 'Retry loading' : 'Load saved model';
  }

  protected statusText() {
    if (this.state === 'checking') return 'Checking model…';
    if (this.state === 'unsupported') return 'Answers unavailable on this device';
    if (this.state === 'loading') {
      if (this.model.stage === 'queued') return 'Waiting to load model…';
      if (this.model.stage === 'downloading') return this.model.downloadedBytes
        ? `Downloaded ${formatBytes(this.model.downloadedBytes)}` : 'Downloading model…';
      return this.model.cache === 'installed' && !this.model.downloadedBytes ? 'Loading saved model…' : 'Initializing model…';
    }
    if (this.ready) return 'Answers ready';
    if (this.state === 'error') {
      if (this.model.failure === 'network') return 'Model download failed. Check your connection and retry.';
      if (this.model.failure === 'storage') return 'Model storage is full. Free space and retry.';
      if (this.model.failure === 'corrupt') return 'Some saved model files are invalid.';
      return 'Model could not load. Retry loading.';
    }
    if (this.model.cache === 'missing') return 'Model not installed';
    if (this.model.cache === 'incomplete') return 'Model install incomplete';
    if (this.model.cache === 'corrupt') return 'Some saved model files are invalid.';
    if (this.model.cache === 'unknown') return 'Could not check model files';
    return 'Model installed · Not loaded';
  }

  updateControls(_restoreFocus = true) {
    this.onState?.(this.state, this.statusText(), { ...this.model });
    for (const listener of this.listeners) listener();
  }

  initializeCapability(): Promise<Capability> {
    if (this.capabilityPromise) return this.capabilityPromise;
    this.capabilityPromise = (async () => {
      const [capability, cache] = await Promise.all([
        this.capabilityDetector().catch(error => ({ supported: false as const, reason: errorMessage(error) })),
        this.cacheInspector().catch(() => 'unknown' as const),
      ]);
      this.capability = capability;
      this.model.cache = cache;
      this.repairNeeded = cache === 'corrupt';
      if (!capability.supported) {
        this.state = 'unsupported';
        this.model.stage = 'idle';
        this.blockPending('Answers unavailable on this device. Document results are ready.');
      } else if (!this.activeLoad) {
        this.state = 'idle';
        this.model.stage = 'idle';
        if (this.pending) {
          if (cache === 'installed') void this.loadAndWait(true);
          else this.blockPending('Document results are ready. Install the model for cited answers.');
        }
      }
      this.updateControls();
      return capability;
    })();
    this.updateControls();
    return this.capabilityPromise;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker === worker) this.handleMessage(event.data);
    };
    worker.onerror = event => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      this.handleMessage({ type: 'error', operation: this.state === 'loading' ? 'load' : 'generate',
        loadId: this.activeLoad, requestId: this.resolution?.id ?? this.activeRequest?.id,
        reason: this.state === 'loading' ? 'initialization' : 'generation',
        message: event.message || 'The model worker stopped unexpectedly.' });
      this.terminateWorker();
      this.state = 'error';
      this.model.stage = 'idle';
      this.model.failure = 'initialization';
      this.updateControls();
    };
    return worker;
  }

  private terminateWorker() {
    this.worker?.terminate();
    this.worker = null;
  }

  private beginLoad() {
    if (this.state === 'loading' || this.ready || this.state === 'unsupported') return undefined;
    const token = ++this.loadNumber;
    this.activeLoad = token;
    this.terminateWorker();
    this.state = 'loading';
    this.model = { ...this.model, stage: 'queued', downloadedBytes: 0, failure: undefined };
    this.updateControls();
    return token;
  }

  private async performLoad(token: number, cachedOnly: boolean) {
    if (!this.capability) await this.initializeCapability();
    if (this.activeLoad !== token) return false;
    if (!this.capability?.supported) { this.settleLoad(); return false; }
    this.model.stage = cachedOnly ? 'initializing' : 'downloading';
    this.updateControls();
    try {
      this.ensureWorker().postMessage({ type: 'load', cachedOnly, loadId: token } satisfies WorkerRequest);
      return true;
    } catch (error) {
      this.handleMessage({ type: 'error', operation: 'load', loadId: token, reason: 'initialization', message: errorMessage(error) });
      this.terminateWorker();
      return false;
    }
  }

  async load(cachedOnly = false) {
    const token = this.beginLoad();
    return token === undefined ? false : this.performLoad(token, cachedOnly);
  }

  async loadAndWait(cachedOnly = false) {
    const token = this.beginLoad();
    if (token === undefined) return;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.loadWaiters.add(settle);
    const task = async () => {
      if (this.activeLoad !== token) return;
      if (await this.performLoad(token, cachedOnly)) await settled;
    };
    try { await (this.loads ? this.loads.run(task) : task()); }
    finally { this.loadWaiters.delete(settle); }
  }

  recoverModel() {
    return this.loadAndWait(!['missing', 'incomplete', 'corrupt'].includes(this.model.cache));
  }

  private settleLoad() {
    this.activeLoad = undefined;
    for (const settle of this.loadWaiters) settle();
    this.loadWaiters.clear();
    this.onLoadSettled?.();
  }

  async refreshCache() {
    const token = this.loadNumber;
    const cache = await this.cacheInspector().catch(() => 'unknown' as const);
    if (token === this.loadNumber) this.setCacheAvailability(cache);
  }

  cancelLoad() {
    if (this.state !== 'loading') return false;
    ++this.loadNumber;
    this.terminateWorker();
    this.state = 'idle';
    this.model.stage = 'idle';
    this.blockPending('Model loading cancelled. Document results are ready.');
    this.settleLoad();
    this.updateControls();
    void this.refreshCache();
    return true;
  }

  beginRetrieval(corpus: Corpus) {
    this.invalidateSearch();
    this.sessions.delete(corpus);
    this.retrievalMessages.delete(corpus);
    this.renderSession(corpus, '');
    this.setFeedback(corpus, '');
    this.updateControls();
    return this.searchNumber;
  }

  isCurrentSearch(token: number | undefined) { return token === undefined || token === this.searchNumber; }

  invalidateSearch() {
    ++this.searchNumber;
    this.cancel(true);
  }

  resetAnswers() {
    this.invalidateSearch();
    this.sessions.clear();
    this.retrievalMessages.clear();
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      this.renderSession(corpus, '');
    }
    this.updateControls();
  }

  generate(options: GenerateOptions) {
    if (!this.isCurrentSearch(options.searchToken)) return false;
    this.cancel(true);
    const session: AnswerSession = { options, text: '', targets: new Map(), phase: 'waiting', message: 'Waiting for the model…' };
    this.sessions.set(options.corpus, session);
    this.retrievalMessages.delete(options.corpus);
    this.renderSession(options.corpus, '');
    if (this.ready) return this.startGeneration(session);
    if (this.state === 'checking' || this.state === 'loading') {
      this.pending = session;
    } else if (this.state !== 'unsupported' && this.model.cache === 'installed' && this.state !== 'error') {
      this.pending = session;
      void this.loadAndWait(true);
    } else {
      session.phase = 'blocked';
      session.message = this.state === 'unsupported'
        ? 'Document results are ready. Answers are unavailable on this device.'
        : 'Document results are ready. Load the model for cited answers.';
    }
    this.updateControls();
    return false;
  }

  private startGeneration(session: AnswerSession) {
    this.pending = null;
    const { corpus, question, documents, citationTargets, evidenceLabel = 'documents', onComplete } = session.options;
    const id = `rag-${++this.requestNumber}`;
    session.phase = 'generating';
    session.message = 'Generating answer…';
    session.text = '';
    session.thinking = '';
    session.targets = new Map();
    this.activeRequest = { id, corpus, answerText: '',
      citationTargets: citationTargetMap(citationTargets), includedTargets: new Map(), evidenceLabel, onComplete, session };
    this.state = 'generating';
    this.renderSession(corpus, '');
    this.setFeedback(corpus, '');
    this.updateControls();
    this.ensureWorker().postMessage({ type: 'generate', requestId: id, corpus, question,
      history: session.options.history, searchQuery: session.options.searchQuery, operation: session.options.operation,
      documents: documents.map(document => ({ id: String(document.id), title: String(document.title ?? ''), text: String(document.text ?? '') })),
    } satisfies WorkerRequest);
    return true;
  }

  retryAnswer(corpus: Corpus) {
    const session = this.sessions.get(corpus);
    if (!session || this.state === 'unsupported' || ['waiting', 'generating'].includes(session.phase)) return false;
    this.invalidateSearch();
    const options = { ...session.options, searchToken: this.searchNumber };
    if (this.state === 'error' && this.model.cache === 'installed') {
      this.generate(options);
      const next = this.sessions.get(corpus)!;
      next.phase = 'waiting';
      next.message = 'Waiting for the model…';
      this.pending = next;
      void this.loadAndWait(true);
      this.updateControls();
      return false;
    }
    return this.generate(options);
  }

  async copyAnswer(corpus: Corpus, clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard) {
    const session = this.sessions.get(corpus);
    if (!session?.text.trim()) return false;
    try {
      if (!clipboard) throw new Error('Clipboard unavailable');
      await clipboard.writeText(session.text);
      this.copyFeedback(corpus, session, 'Copied', 3000);
      return true;
    } catch {
      this.copyFeedback(corpus, session, 'Could not copy. Select the answer text to copy.', 6000);
      return false;
    }
  }

  private copyFeedback(corpus: Corpus, session: AnswerSession, message: string, duration: number) {
    if (this.sessions.get(corpus) !== session) return;
    clearTimeout(this.feedbackTimers.get(corpus));
    this.setFeedback(corpus, message);
    this.feedbackTimers.set(corpus, setTimeout(() => {
      if (this.sessions.get(corpus) === session) this.setFeedback(corpus, '');
      this.feedbackTimers.delete(corpus);
    }, duration));
  }

  showRetrievalMessage(corpus: Corpus, message: string, searchToken?: number) {
    if (!this.isCurrentSearch(searchToken)) return;
    if (this.activeRequest?.corpus === corpus || this.pending?.options.corpus === corpus) this.cancel(true);
    this.sessions.delete(corpus);
    this.retrievalMessages.set(corpus, message);
    this.renderSession(corpus, message);
    this.updateControls();
  }

  cancel(quiet = false) {
    if (this.resolution) {
      const task = this.resolution;
      this.resolution = undefined;
      this.worker?.postMessage({ type: 'cancel', requestId: task.id } satisfies WorkerRequest);
      this.state = 'ready';
      task.reject(new DOMException('Cancelled', 'AbortError'));
      this.updateControls(!quiet);
      return true;
    }
    const session = this.activeRequest?.session ?? this.pending;
    if (!session) return false;
    if (this.activeRequest) this.worker?.postMessage({ type: 'cancel', requestId: this.activeRequest.id } satisfies WorkerRequest);
    this.activeRequest = null;
    this.pending = null;
    if (this.state === 'generating') this.state = 'ready';
    session.phase = 'stopped';
    session.message = 'Stopped';
    if (session.text.trim()) session.options.onStopped?.(session.text, citedIds(session.text, session.targets));
    session.options.onCancelled?.();
    this.updateControls(!quiet);
    return true;
  }

  private blockPending(message: string) {
    if (!this.pending) return;
    this.pending.phase = 'blocked';
    this.pending.message = message;
    this.pending = null;
  }

  handleMessage(message: WorkerResponse) {
    if ('loadId' in message && message.loadId !== undefined && message.loadId !== this.activeLoad) return;
    try { this.handleWorkerMessage(message); }
    finally { this.updateControls(); }
  }

  handleWorkerMessage(message: WorkerResponse) {
    if ('requestId' in message && message.requestId && this.resolution?.id === message.requestId) {
      const task = this.resolution;
      if (message.type === 'resolved-query' || message.type === 'error' || message.type === 'cancelled') {
        this.resolution = undefined;
        this.state = 'ready';
        if (message.type === 'resolved-query') task.resolve({ query: message.query, contextLimited: message.contextLimited });
        else task.reject(message.type === 'cancelled' ? new DOMException('Cancelled', 'AbortError') : new Error(message.message));
      }
      return;
    }
    if (message.type === 'cache-status') {
      this.model.cache = message.availability;
      if (message.availability === 'installed') this.model.stage = 'initializing';
      return;
    }
    if (message.type === 'cache-unavailable' || (message.type === 'error' && message.operation === 'load')) {
      const reason = message.reason ?? 'initialization';
      this.model.failure = reason;
      this.model.stage = 'idle';
      if (reason === 'missing' || reason === 'incomplete' || reason === 'corrupt') this.model.cache = reason;
      this.repairNeeded = reason === 'corrupt';
      this.state = message.type === 'cache-unavailable' && ['missing', 'incomplete', 'corrupt'].includes(reason) ? 'idle' : 'error';
      console.warn('Could not load saved model:', message.message);
      this.blockPending('Model could not load. Document results are ready.');
      this.settleLoad();
      return;
    }
    if (message.type === 'progress') {
      if (this.state !== 'loading') return;
      if (message.progress.stage) this.model.stage = message.progress.stage;
      if (Number.isFinite(message.progress.downloadedBytes)) this.model.downloadedBytes = Math.max(this.model.downloadedBytes, message.progress.downloadedBytes!);
      return;
    }
    if (message.type === 'ready') {
      this.repairNeeded = false;
      this.state = 'ready';
      this.model = { ...this.model, cache: 'installed', stage: 'ready', failure: undefined };
      this.settleLoad();
      const pending = this.pending;
      if (pending && this.isCurrentSearch(pending.options.searchToken)) this.startGeneration(pending);
      return;
    }
    if ('requestId' in message && message.requestId && message.requestId !== this.activeRequest?.id) return;
    const request = this.activeRequest;
    if (!request) return;
    const session = request.session;
    if (message.type === 'context' || message.type === 'complete') {
      const included = new Set(message.documentIds.map(String));
      request.includedTargets = new Map([...request.citationTargets].filter(([id]) => included.has(id)));
      session.targets = request.includedTargets;
    }
    if (message.type === 'context') {
      session.options.onContext?.(message.documentIds, message.contextLimited === true);
      this.renderSession(request.corpus, session.text, session.targets);
    } else if (message.type === 'thinking-delta') {
      session.thinking = (session.thinking ?? '') + message.text;
      session.options.onThinkingDelta?.(message.text);
    } else if (message.type === 'answer-delta') {
      request.answerText += message.text;
      session.text = request.answerText;
      session.options.onDelta?.(message.text);
      this.renderSession(request.corpus, session.text, session.targets);
    } else if (message.type === 'complete') {
      if (!String(message.answer ?? '').trim()) {
        this.handleWorkerMessage({ type: 'error', operation: 'generate', requestId: request.id,
          reason: 'generation', message: 'The model stopped before producing an answer.' });
        return;
      }
      session.text = request.answerText = message.answer;
      session.thinking = message.thinking ?? session.thinking;
      this.renderSession(request.corpus, session.text, session.targets);
      session.phase = 'complete';
      session.message = `Answer generated using ${message.documentIds.length} ${message.documentIds.length === 1 ? request.evidenceLabel.replace(/s$/, '') : request.evidenceLabel}.`;
      this.activeRequest = null;
      this.state = 'ready';
      this.repairNeeded = false;
      request.onComplete?.(session.text, citedIds(session.text, session.targets));
    } else if (message.type === 'cancelled') {
      this.cancel();
    } else if (message.type === 'error') {
      this.activeRequest = null;
      this.state = 'ready';
      this.repairNeeded = message.reason === 'corrupt';
      session.phase = 'error';
      session.message = 'Answer generation failed. Retry answer.';
      console.warn('Could not generate answer:', message.message);
      session.options.onError?.(new Error(message.message));
    }
  }

  dispose() {
    this.invalidateSearch();
    ++this.loadNumber;
    this.terminateWorker();
    for (const timer of this.feedbackTimers.values()) clearTimeout(timer);
    this.feedbackTimers.clear();
    if (this.state === 'loading') this.state = 'idle';
    this.model.stage = 'idle';
    this.settleLoad();
  }
}
