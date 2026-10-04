import { errorMessage, requiredElement } from './boundaries.ts';
import type { Corpus, EvidenceDocument, ModelCacheAvailability, ModelStatus, WorkerRequest, WorkerResponse } from './types.ts';
import { inspectModelCache } from './model-readiness.ts';
import { formatBytes } from './storage-dashboard.ts';
import type { LoadCoordinator } from './load-coordinator.ts';

export type Capability = { supported: true } | { supported: false; reason: string };
type CitationTargets = Map<string, string> | Record<string, string>;

interface ControllerElements {
  setup?: HTMLElement | null;
  loadButton: HTMLButtonElement;
  stopButton?: HTMLButtonElement;
  cancelLoadButton?: HTMLButtonElement;
  searchStatus?: HTMLElement;
  searchLoadButton?: HTMLButtonElement;
  searchCancelButton?: HTMLButtonElement;
  installedStatus?: HTMLElement;
  announcement?: HTMLElement;
  settingsLink?: HTMLElement;
  repairLink?: HTMLElement;
  answerControls?: Partial<Record<Corpus, AnswerControls>>;
  status: HTMLElement;
  progress: HTMLProgressElement;
  answers?: Partial<Record<Corpus, HTMLElement>>;
  answer?: HTMLElement;
  generating?: Partial<Record<Corpus, HTMLElement>>;
  modelCard?: HTMLElement;
}

interface AnswerControls {
  stop: HTMLButtonElement;
  copy: HTMLButtonElement;
  retry: HTMLButtonElement;
  load: HTMLButtonElement;
  status: HTMLElement;
  feedback: HTMLElement;
}

interface AnswerSession {
  options: GenerateOptions;
  text: string;
  targets: Map<string, string>;
  phase: 'waiting' | 'generating' | 'complete' | 'stopped' | 'error' | 'blocked';
  message: string;
}

interface ActiveRequest {
  id: string;
  corpus: Corpus;
  answer: HTMLElement;
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
  onStopped?: (answer: string, citedIds: string[]) => void;
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

function citationTargetMap(citationTargets?: CitationTargets): Map<string, string> {
  if (citationTargets instanceof Map) {
    return new Map([...citationTargets].map(([id, target]) => [String(id), String(target)]));
  }
  return new Map(Object.entries(citationTargets ?? {}).map(([id, target]) => [String(id), String(target)]));
}

const CITATION = /\[([A-Za-z0-9_.:-]+)\]/g;

export function citedIds(text: string, available: Map<string, string>): string[] {
  return [...new Set([...text.matchAll(CITATION)].map(match => match[1]))].filter(id => available.has(id));
}

export function renderAnswer(container: HTMLElement, text: unknown, citationTargets: CitationTargets = new Map()) {
  const value = String(text ?? '');
  const targets = citationTargetMap(citationTargets);
  if (!container.ownerDocument || typeof container.replaceChildren !== 'function') {
    container.textContent = value;
    return;
  }
  const nodes = [];
  let position = 0;
  for (const match of value.matchAll(CITATION)) {
    if (match.index > position) nodes.push(container.ownerDocument.createTextNode(value.slice(position, match.index)));
    const id = match[1];
    if (targets.has(id)) {
      const link = container.ownerDocument.createElement('a');
      link.href = targets.get(id) ?? '';
      link.textContent = match[0];
      link.title = `Jump to retrieved evidence ${id}`;
      nodes.push(link);
    } else {
      nodes.push(container.ownerDocument.createTextNode(match[0]));
    }
    position = match.index + match[0].length;
  }
  if (position < value.length) nodes.push(container.ownerDocument.createTextNode(value.slice(position)));
  container.replaceChildren(...nodes);
}

function setText(element: HTMLElement | undefined, text: string) {
  if (element && element.textContent !== text) element.textContent = text;
}

export class LLMController {
  private elements: ControllerElements;
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
  private answers: Partial<Record<Corpus, HTMLElement>>;
  private sessions = new Map<Corpus, AnswerSession>();
  private retrievalMessages = new Map<Corpus, string>();
  private pending: AnswerSession | null = null;
  private announcementKey = '';
  private feedbackTimers = new Map<Corpus, ReturnType<typeof setTimeout>>();
  private onLoadSettled?: () => void;
  state: ControllerState = 'checking';
  activeRequest: ActiveRequest | null = null;
  repairNeeded = false;
  model: ModelStatus = { cache: 'checking', stage: 'checking', downloadedBytes: 0 };

  constructor({ elements, workerFactory = defaultWorkerFactory, detectWebGPU: capabilityDetector = detectWebGPU,
    inspectCache = async () => (await inspectModelCache()).availability, onState, loads,
  }: { elements: ControllerElements; workerFactory?: () => Worker; detectWebGPU?: () => Promise<Capability>;
    inspectCache?: () => Promise<ModelCacheAvailability>; loads?: LoadCoordinator;
    onState?: (state: ControllerState, message: string, model: ModelStatus) => void }) {
    this.elements = elements;
    this.workerFactory = workerFactory;
    this.capabilityDetector = capabilityDetector;
    this.cacheInspector = inspectCache;
    this.loads = loads;
    this.onState = onState;
    this.answers = elements.answers ?? { nfcorpus: elements.answer };
  }

  get ready() { return this.state === 'ready' || this.state === 'generating'; }

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

  private statusText() {
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

  updateControls(restoreFocus = true) {
    const focused = this.elements.loadButton.ownerDocument?.activeElement;
    const message = this.statusText();
    setText(this.elements.status, message);
    setText(this.elements.searchStatus, message);
    const cacheLabels: Record<ModelCacheAvailability, string> = {
      checking: 'Checking installed files…', missing: 'Not installed', incomplete: 'Incomplete install',
      installed: 'Installed · MiniCPM5-2B', corrupt: 'Invalid model files', unknown: 'Installed files unavailable',
    };
    setText(this.elements.installedStatus, cacheLabels[this.model.cache]);
    const canLoad = !['checking', 'unsupported', 'loading', 'ready', 'generating'].includes(this.state);
    for (const button of [this.elements.loadButton, this.elements.searchLoadButton]) {
      if (!button) continue;
      button.hidden = !canLoad;
      button.disabled = !canLoad;
      button.textContent = this.loadAction();
    }
    for (const button of [this.elements.cancelLoadButton, this.elements.searchCancelButton]) {
      if (!button) continue;
      button.hidden = this.state !== 'loading';
      button.disabled = this.state !== 'loading';
      button.textContent = this.model.stage === 'downloading' ? 'Cancel download' : 'Cancel loading';
    }
    this.elements.progress.hidden = this.state !== 'loading';
    this.elements.progress.removeAttribute?.('value');
    if (this.elements.setup) this.elements.setup.hidden = !canLoad;
    if (this.elements.settingsLink) this.elements.settingsLink.hidden = this.ready || this.state === 'loading' || this.state === 'checking';
    if (this.elements.repairLink) this.elements.repairLink.hidden = !this.repairNeeded;
    if (this.elements.stopButton) {
      this.elements.stopButton.hidden = !this.activeRequest && !this.pending;
      this.elements.stopButton.disabled = !this.activeRequest && !this.pending;
    }
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      const session = this.sessions.get(corpus);
      const running = session?.phase === 'waiting' || session?.phase === 'generating';
      const indicator = this.elements.generating?.[corpus];
      if (indicator) indicator.hidden = !running;
      const controls = this.elements.answerControls?.[corpus];
      if (!controls) continue;
      setText(controls.status, session?.message ?? this.retrievalMessages.get(corpus) ?? '');
      controls.stop.hidden = !running;
      controls.stop.disabled = !running;
      controls.copy.disabled = !session?.text.trim();
      const recover = session?.phase === 'blocked' && canLoad;
      controls.load.hidden = !recover;
      controls.load.disabled = !recover;
      controls.load.textContent = this.loadAction();
      controls.retry.hidden = !session || running || recover || this.state === 'unsupported';
      controls.retry.disabled = !session || running || this.state === 'unsupported';
    }
    this.elements.modelCard?.toggleAttribute?.('data-repair', this.repairNeeded);
    this.elements.modelCard?.setAttribute?.('data-phase', this.state);
    this.elements.searchStatus?.setAttribute?.('data-phase', this.state);
    const key = `${this.state}:${this.model.stage}:${this.model.failure ?? ''}:${this.model.cache}`;
    if (key !== this.announcementKey) {
      this.announcementKey = key;
      setText(this.elements.announcement, this.model.stage === 'downloading' ? 'Downloading model…' : message);
    }
    if (restoreFocus) this.restoreControlFocus(focused);
    this.onState?.(this.state, message, { ...this.model });
  }

  private restoreControlFocus(focused: Element | null | undefined) {
    if (!focused || !('hidden' in focused) || (!focused.hidden && !('disabled' in focused && focused.disabled))) return;
    let next: HTMLElement | undefined;
    for (const [load, cancel] of [
      [this.elements.loadButton, this.elements.cancelLoadButton],
      [this.elements.searchLoadButton, this.elements.searchCancelButton],
    ]) {
      if (focused === load) next = cancel;
      else if (focused === cancel) next = load;
    }
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      const controls = this.elements.answerControls?.[corpus];
      if (!controls || ![controls.stop, controls.copy, controls.retry, controls.load].includes(focused as HTMLButtonElement)) continue;
      next = !controls.stop.hidden ? controls.stop : !controls.load.hidden ? controls.load
        : !controls.copy.disabled ? controls.copy : controls.retry;
    }
    if (next && !next.hidden && !('disabled' in next && next.disabled)) next.focus();
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
        loadId: this.activeLoad, requestId: this.activeRequest?.id,
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

  answerFor(corpus: Corpus) {
    const answer = this.answers[corpus];
    if (!answer) throw new Error(`No answer destination is configured for ${corpus}.`);
    return answer;
  }

  beginRetrieval(corpus: Corpus) {
    this.invalidateSearch();
    this.sessions.delete(corpus);
    this.retrievalMessages.delete(corpus);
    renderAnswer(this.answerFor(corpus), '');
    setText(this.elements.answerControls?.[corpus]?.feedback, '');
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
      if (this.answers[corpus]) renderAnswer(this.answerFor(corpus), '');
    }
    this.updateControls();
  }

  generate(options: GenerateOptions) {
    if (!this.isCurrentSearch(options.searchToken)) return false;
    this.cancel(true);
    const session: AnswerSession = { options, text: '', targets: new Map(), phase: 'waiting', message: 'Waiting for the model…' };
    this.sessions.set(options.corpus, session);
    this.retrievalMessages.delete(options.corpus);
    renderAnswer(this.answerFor(options.corpus), '');
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
    session.targets = new Map();
    this.activeRequest = { id, corpus, answer: this.answerFor(corpus), answerText: '',
      citationTargets: citationTargetMap(citationTargets), includedTargets: new Map(), evidenceLabel, onComplete, session };
    this.state = 'generating';
    renderAnswer(this.activeRequest.answer, '');
    setText(this.elements.answerControls?.[corpus]?.feedback, '');
    this.updateControls();
    this.ensureWorker().postMessage({ type: 'generate', requestId: id, corpus, question,
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
    const feedback = this.elements.answerControls?.[corpus]?.feedback;
    setText(feedback, message);
    this.feedbackTimers.set(corpus, setTimeout(() => {
      if (this.sessions.get(corpus) === session) setText(feedback, '');
      this.feedbackTimers.delete(corpus);
    }, duration));
  }

  showRetrievalMessage(corpus: Corpus, message: string, searchToken?: number) {
    if (!this.isCurrentSearch(searchToken)) return;
    if (this.activeRequest?.corpus === corpus || this.pending?.options.corpus === corpus) this.cancel(true);
    this.sessions.delete(corpus);
    this.retrievalMessages.set(corpus, message);
    const controls = this.elements.answerControls?.[corpus];
    renderAnswer(this.answerFor(corpus), controls ? '' : message);
    this.updateControls();
    setText(controls?.status, message);
  }

  cancel(quiet = false) {
    const session = this.activeRequest?.session ?? this.pending;
    if (!session) return false;
    if (this.activeRequest) this.worker?.postMessage({ type: 'cancel', requestId: this.activeRequest.id } satisfies WorkerRequest);
    this.activeRequest = null;
    this.pending = null;
    if (this.state === 'generating') this.state = 'ready';
    session.phase = 'stopped';
    session.message = 'Stopped';
    if (session.text.trim()) session.options.onStopped?.(session.text, citedIds(session.text, session.targets));
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
      renderAnswer(request.answer, session.text, session.targets);
    } else if (message.type === 'answer-delta') {
      request.answerText += message.text;
      session.text = request.answerText;
      renderAnswer(request.answer, session.text, session.targets);
    } else if (message.type === 'complete') {
      if (!String(message.answer ?? '').trim()) {
        this.handleWorkerMessage({ type: 'error', operation: 'generate', requestId: request.id,
          reason: 'generation', message: 'The model stopped before producing an answer.' });
        return;
      }
      session.text = request.answerText = message.answer;
      renderAnswer(request.answer, session.text, session.targets);
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

export function setupLLM(onState?: (state: ControllerState, message: string, model: ModelStatus) => void, loads?: LoadCoordinator) {
  const answerControls = Object.fromEntries((['nfcorpus', 'msmarco'] as const).map(corpus => {
    const prefix = corpus === 'nfcorpus' ? 'fts' : 'marco';
    return [corpus, {
      stop: requiredElement<HTMLButtonElement>(`#${prefix}-answer-stop`),
      copy: requiredElement<HTMLButtonElement>(`#${prefix}-answer-copy`),
      retry: requiredElement<HTMLButtonElement>(`#${prefix}-answer-retry`),
      load: requiredElement<HTMLButtonElement>(`#${prefix}-answer-load`),
      status: requiredElement<HTMLElement>(`#${prefix}-answer-status`),
      feedback: requiredElement<HTMLElement>(`#${prefix}-answer-feedback`),
    }];
  })) as Record<Corpus, AnswerControls>;
  const elements: ControllerElements = {
    setup: requiredElement<HTMLElement>('#llm-setup'),
    loadButton: requiredElement<HTMLButtonElement>('#llm-load'),
    cancelLoadButton: requiredElement<HTMLButtonElement>('#llm-cancel-load'),
    searchStatus: requiredElement<HTMLElement>('#model-search-status'),
    searchLoadButton: requiredElement<HTMLButtonElement>('#model-search-load'),
    searchCancelButton: requiredElement<HTMLButtonElement>('#model-search-cancel'),
    installedStatus: requiredElement<HTMLElement>('#model-installed-status'),
    announcement: requiredElement<HTMLElement>('#model-announcement'),
    settingsLink: requiredElement<HTMLElement>('#model-setup-link'),
    repairLink: requiredElement<HTMLElement>('#model-repair-link'),
    modelCard: requiredElement<HTMLElement>('#model'),
    status: requiredElement<HTMLElement>('#llm-status'),
    progress: requiredElement<HTMLProgressElement>('#llm-progress'),
    generating: { nfcorpus: requiredElement<HTMLElement>('#fts-generating'), msmarco: requiredElement<HTMLElement>('#marco-generating') },
    answers: { nfcorpus: requiredElement<HTMLElement>('#fts-answer'), msmarco: requiredElement<HTMLElement>('#marco-answer') },
    answerControls,
  };
  const controller = new LLMController({ elements, onState, loads });
  elements.loadButton.onclick = elements.searchLoadButton!.onclick = () => { void controller.recoverModel(); };
  elements.cancelLoadButton!.onclick = elements.searchCancelButton!.onclick = () => { controller.cancelLoad(); };
  for (const corpus of ['nfcorpus', 'msmarco'] as const) {
    const controls = answerControls[corpus];
    controls.stop.onclick = () => { controller.cancel(); };
    controls.copy.onclick = () => { void controller.copyAnswer(corpus); };
    controls.retry.onclick = () => { controller.retryAnswer(corpus); };
    controls.load.onclick = () => { void controller.recoverModel(); controller.retryAnswer(corpus); };
  }
  controller.updateControls();
  return controller;
}
