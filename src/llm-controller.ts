import { errorMessage, requiredElement } from './boundaries.ts';
import type { Corpus, EvidenceDocument, ModelProgress, WorkerRequest, WorkerResponse } from './types.ts';
import type { LoadCoordinator } from './load-coordinator.ts';

export type Capability = { supported: true } | { supported: false; reason: string };
type CitationTargets = Map<string, string> | Record<string, string>;

interface ControllerElements {
  setup?: HTMLElement | null;
  loadButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  status: HTMLElement;
  progress: HTMLProgressElement;
  answers?: Partial<Record<Corpus, HTMLElement>>;
  answer?: HTMLElement;
  generating?: Partial<Record<Corpus, HTMLElement>>;
  modelCard?: HTMLElement;
}

interface ActiveRequest {
  id: string;
  corpus: Corpus;
  answer: HTMLElement;
  answerText: string;
  citationTargets: Map<string, string>;
  includedTargets: Map<string, string>;
  evidenceLabel: string;
}

export type ControllerState = 'checking' | 'unsupported' | 'idle' | 'loading' | 'ready' | 'generating' | 'error';

export interface GenerateOptions {
  corpus: Corpus;
  question: string;
  documents: EvidenceDocument[];
  citationTargets: CitationTargets;
  evidenceLabel?: string;
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

function progressPercent(progress: ModelProgress): number | null {
  if (typeof progress.progress === 'number' && Number.isFinite(progress.progress)) return Math.min(100, Math.max(0, progress.progress));
  if (typeof progress.loaded === 'number' && Number.isFinite(progress.loaded) &&
      typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total > 0) {
    return Math.min(100, Math.max(0, progress.loaded / progress.total * 100));
  }
  return null;
}

function citationTargetMap(citationTargets?: CitationTargets): Map<string, string> {
  if (citationTargets instanceof Map) {
    return new Map([...citationTargets].map(([id, target]) => [String(id), String(target)]));
  }
  return new Map(Object.entries(citationTargets ?? {}).map(([id, target]) => [String(id), String(target)]));
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
  for (const match of value.matchAll(/\[([A-Za-z0-9_.:-]+)\]/g)) {
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

export class LLMController {
  private elements: ControllerElements;
  private workerFactory: () => Worker;
  private capabilityDetector: () => Promise<Capability>;
  private worker: Worker | null;
  private capability: Capability | null;
  state: ControllerState;
  activeRequest: ActiveRequest | null;
  private requestNumber: number;
  private answers: Partial<Record<Corpus, HTMLElement>>;
  private onState?: (state: ControllerState, message: string) => void;
  private loadWaiters = new Set<() => void>();
  // Set after a load or generation failure; highlights the delete-and-redownload hint in Settings.
  repairNeeded = false;

  constructor({
    elements,
    workerFactory = defaultWorkerFactory,
    detectWebGPU: capabilityDetector = detectWebGPU,
    onState,
  }: { elements: ControllerElements; workerFactory?: () => Worker; detectWebGPU?: () => Promise<Capability>; onState?: (state: ControllerState, message: string) => void }) {
    this.elements = elements;
    this.workerFactory = workerFactory;
    this.capabilityDetector = capabilityDetector;
    this.worker = null;
    this.capability = null;
    this.state = 'checking';
    this.activeRequest = null;
    this.requestNumber = 0;
    this.answers = elements.answers ?? { nfcorpus: elements.answer };
    this.onState = onState;
  }

  get ready() {
    return this.state === 'ready' || this.state === 'generating';
  }

  updateControls() {
    for (const corpus of ['nfcorpus', 'msmarco'] as const) {
      const indicator = this.elements.generating?.[corpus];
      if (indicator) indicator.hidden = this.state !== 'generating' || this.activeRequest?.corpus !== corpus;
    }
    if (this.elements.setup) {
      this.elements.setup.hidden = !['idle', 'error'].includes(this.state);
    }
    this.elements.stopButton.hidden = this.state !== 'generating';
    this.elements.modelCard?.toggleAttribute?.('data-repair', this.repairNeeded);
    this.onState?.(this.state, this.elements.status.textContent);
  }

  async initializeCapability() {
    this.state = 'checking';
    this.elements.loadButton.hidden = true;
    this.elements.loadButton.disabled = true;
    this.elements.stopButton.disabled = true;
    this.elements.status.textContent = 'Checking WebGPU support…';
    this.updateControls();
    try {
      this.capability = await this.capabilityDetector();
    } catch (error) {
      this.capability = { supported: false, reason: errorMessage(error) };
    }
    if (!this.capability.supported) {
      this.state = 'unsupported';
      this.elements.status.textContent = `${this.capability.reason} BM25 search remains available.`;
      this.elements.loadButton.disabled = true;
      this.updateControls();
      return this.capability;
    }
    this.state = 'idle';
    this.elements.loadButton.hidden = false;
    this.elements.status.textContent = 'WebGPU is ready. Load the local model when you want cited answers.';
    this.elements.loadButton.disabled = false;
    this.updateControls();
    return this.capability;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = this.workerFactory();
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = event => {
      event.preventDefault?.();
      this.handleMessage({
        type: 'error',
        operation: this.state === 'loading' ? 'load' : 'generate',
        requestId: this.activeRequest?.id,
        message: event.message || 'The LLM worker stopped unexpectedly.',
      });
    };
    return this.worker;
  }

  private send(message: WorkerRequest) {
    this.ensureWorker().postMessage(message);
  }

  async load(cachedOnly = false) {
    if (!this.capability) await this.initializeCapability();
    if (!this.capability?.supported || this.state === 'loading' || this.ready) return false;
    this.state = 'loading';
    this.elements.loadButton.hidden = true;
    this.elements.loadButton.disabled = true;
    this.elements.stopButton.disabled = true;
    this.elements.progress.hidden = false;
    this.elements.progress.removeAttribute?.('value');
    this.elements.status.textContent = cachedOnly ? 'Loading saved model from this browser…' : 'Starting the local model download…';
    this.updateControls();
    this.send(cachedOnly ? { type: 'load', cachedOnly: true } : { type: 'load' });
    return true;
  }

  async loadAndWait(cachedOnly = false) {
    let resolveLoad!: () => void;
    const settled = new Promise<void>(resolve => { resolveLoad = resolve; });
    this.loadWaiters.add(resolveLoad);
    try {
      if (!await this.load(cachedOnly)) return;
      await settled;
    } finally {
      this.loadWaiters.delete(resolveLoad);
    }
  }

  answerFor(corpus: Corpus) {
    const answer = this.answers[corpus];
    if (!answer) throw new Error(`No answer destination is configured for ${corpus}.`);
    return answer;
  }

  beginRetrieval(corpus: Corpus) {
    if (this.activeRequest) this.cancel(true);
    renderAnswer(this.answerFor(corpus), '');
  }

  generate({ corpus, question, documents, citationTargets, evidenceLabel = 'documents' }: GenerateOptions) {
    const answer = this.answerFor(corpus);
    if (!this.ready || this.state === 'loading') {
      const message = this.state === 'unsupported'
        ? 'BM25 results are ready. Local answer generation is unavailable on this device.'
        : 'BM25 results are ready. Load the local LLM to generate an answer from the retrieved evidence.';
      renderAnswer(answer, message);
      if (this.state !== 'unsupported' && answer.ownerDocument) {
        const doc = answer.ownerDocument;
        const link = doc.createElement('a');
        link.href = '?view=setup#model';
        link.textContent = 'Load';
        link.onclick = event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          doc.querySelector<HTMLAnchorElement>('#model-setup-link')?.click();
        };
        answer.replaceChildren(
          doc.createTextNode('BM25 results are ready. '), link,
          doc.createTextNode(' the local LLM to generate an answer from the retrieved evidence.'),
        );
      }
      return false;
    }
    if (this.activeRequest) this.cancel(true);
    const requestId = `rag-${++this.requestNumber}`;
    this.activeRequest = {
      id: requestId,
      corpus,
      answer,
      answerText: '',
      citationTargets: citationTargetMap(citationTargets),
      includedTargets: new Map(),
      evidenceLabel,
    };
    this.state = 'generating';
    renderAnswer(answer, '');
    const corpusName = corpus === 'msmarco' ? 'MS MARCO' : 'NFCorpus';
    this.elements.status.textContent = `Generating an answer from ${corpusName} evidence locally…`;
    this.elements.stopButton.disabled = false;
    this.updateControls();
    this.send({
      type: 'generate',
      requestId,
      corpus,
      question,
      documents: documents.map(document => ({
        id: String(document.id),
        title: String(document.title ?? ''),
        text: String(document.text ?? ''),
      })),
    });
    return true;
  }

  showRetrievalMessage(corpus: Corpus, message: string) {
    if (this.activeRequest?.corpus === corpus) this.cancel(true);
    renderAnswer(this.answerFor(corpus), message);
  }

  cancel(quiet = false) {
    if (!this.activeRequest || !this.worker) return false;
    const requestId = this.activeRequest.id;
    this.worker.postMessage({ type: 'cancel', requestId });
    this.activeRequest = null;
    this.state = 'ready';
    this.elements.stopButton.disabled = true;
    if (!quiet) this.elements.status.textContent = 'Generation stopped. BM25 results remain available.';
    this.updateControls();
    return true;
  }

  handleMessage(message: WorkerResponse) {
    try {
      this.handleWorkerMessage(message);
    } finally {
      this.updateControls();
      if (this.state !== 'loading') {
        for (const resolve of this.loadWaiters) resolve();
        this.loadWaiters.clear();
      }
    }
  }

  handleWorkerMessage(message: WorkerResponse) {
    if (message.type === 'cache-unavailable') {
      this.repairNeeded = true;
      this.state = 'idle';
      this.elements.loadButton.hidden = false;
      this.elements.progress.hidden = true;
      this.elements.loadButton.disabled = false;
      this.elements.status.textContent = 'The saved model is incomplete or could not be opened. Click “Load local LLM” to download missing files or retry. Search still works without it.';
      return;
    }
    if (message.type === 'progress' && this.state === 'loading') {
      const percent = progressPercent(message.progress);
      const file = message.progress?.file ? ` ${message.progress.file}` : '';
      if (percent === null) {
        this.elements.progress.removeAttribute?.('value');
        this.elements.status.textContent = message.progress.status === 'done'
          ? `Loaded${file}. Preparing remaining model files and the GPU session…`
          : `Reading model file${file}… Progress is not available for this step.`;
      } else {
        this.elements.progress.max = 100;
        this.elements.progress.value = percent;
        this.elements.status.textContent = `Loading model${file}… ${percent.toFixed(0)}%`;
      }
      return;
    }
    if (message.type === 'ready') {
      this.repairNeeded = false;
      this.elements.loadButton.hidden = true;
      this.state = 'ready';
      this.elements.progress.hidden = true;
      this.elements.loadButton.disabled = true;
      this.elements.stopButton.disabled = true;
      this.elements.status.textContent = 'Local MiniCPM5-2B model ready. Searches will now generate cited answers.';
      return;
    }
    if ('requestId' in message && message.requestId && message.requestId !== this.activeRequest?.id) return;
    const request = this.activeRequest;
    if (message.type === 'context') {
      if (!request) return;
      const included = new Set((message.documentIds ?? []).map(String));
      request.includedTargets = new Map(
        [...request.citationTargets].filter(([id]) => included.has(id)),
      );
      renderAnswer(
        request.answer,
        request.answerText,
        request.includedTargets,
      );
      return;
    }
    if (message.type === 'answer-delta') {
      if (!request) return;
      request.answerText += message.text;
      renderAnswer(
        request.answer,
        request.answerText,
        request.includedTargets,
      );
      return;
    }
    if (message.type === 'complete') {
      if (!request) return;
      if (!String(message.answer ?? '').trim()) {
        this.handleMessage({
          type: 'error',
          operation: 'generate',
          requestId: message.requestId,
          message: 'The model stopped before producing an answer. Please retry the search.',
        });
        return;
      }
      const included = new Set((message.documentIds ?? []).map(String));
      request.includedTargets = new Map(
        [...request.citationTargets].filter(([id]) => included.has(id)),
      );
      request.answerText = message.answer;
      renderAnswer(request.answer, request.answerText, request.includedTargets);
      this.repairNeeded = false;
      this.activeRequest = null;
      this.state = 'ready';
      this.elements.stopButton.disabled = true;
      const count = message.documentIds?.length ?? 0;
      const label = count === 1 ? request.evidenceLabel.replace(/s$/, '') : request.evidenceLabel;
      this.elements.status.textContent = `Answer generated using ${count} ${label}.`;
      return;
    }
    if (message.type === 'cancelled') {
      this.activeRequest = null;
      this.state = 'ready';
      this.elements.stopButton.disabled = true;
      this.elements.status.textContent = 'Generation stopped. BM25 results remain available.';
      return;
    }
    if (message.type === 'error') {
      this.repairNeeded = true;
      if (message.operation === 'load') {
        this.elements.loadButton.hidden = false;
        this.state = 'error';
        this.elements.progress.hidden = true;
        this.elements.loadButton.disabled = false;
        this.elements.status.textContent = `Model load failed: ${message.message}. You can retry.`;
      } else {
        this.activeRequest = null;
        this.state = 'ready';
        this.elements.stopButton.disabled = true;
        this.elements.status.textContent = `Answer generation failed: ${message.message}. BM25 results remain available.`;
        if (request) showRepairGuidance(request.answer, message.message);
      }
    }
  }

  dispose() {
    if (this.activeRequest) this.cancel(true);
    this.worker?.terminate();
    this.worker = null;
    for (const resolve of this.loadWaiters) resolve();
    this.loadWaiters.clear();
  }
}

// A failed generation usually means damaged model files; walk the user through reinstalling.
function showRepairGuidance(answer: HTMLElement, reason: string) {
  const text = `The local model couldn’t write an answer (${reason}). Its saved files may be damaged. `
    + 'To fix it, delete the installed model in Settings, then download it again. The search results below are unaffected.';
  const doc = answer.ownerDocument;
  if (!doc || typeof answer.replaceChildren !== 'function') {
    answer.textContent = text;
    return;
  }
  const box = doc.createElement('span');
  box.className = 'answer-repair';
  const message = doc.createElement('span');
  message.textContent = text;
  const link = doc.createElement('a');
  link.className = 'answer-repair-link';
  link.href = '?view=setup#model-storage';
  link.textContent = 'Repair the model →';
  link.onclick = event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    doc.querySelector<HTMLAnchorElement>('#model-repair-link')?.click();
  };
  box.append(message, link);
  answer.replaceChildren(box);
}

export function setupLLM(onState?: (state: ControllerState, message: string) => void, loads?: LoadCoordinator) {
  const elements = {
    setup: requiredElement<HTMLElement>('#llm-setup'),
    loadButton: requiredElement<HTMLButtonElement>('#llm-load'),
    stopButton: requiredElement<HTMLButtonElement>('#llm-stop'),
    modelCard: requiredElement<HTMLElement>('#model'),
    status: requiredElement<HTMLElement>('#llm-status'),
    progress: requiredElement<HTMLProgressElement>('#llm-progress'),
    generating: {
      nfcorpus: requiredElement<HTMLElement>('#fts-generating'),
      msmarco: requiredElement<HTMLElement>('#marco-generating'),
    },
    answers: {
      nfcorpus: requiredElement<HTMLElement>('#fts-answer'),
      msmarco: requiredElement<HTMLElement>('#marco-answer'),
    },
  };
  const controller = new LLMController({ elements, onState });
  let queued = false;
  elements.loadButton.onclick = async () => {
    if (queued) return;
    queued = true;
    elements.loadButton.disabled = true;
    elements.status.textContent = 'Waiting to load the local model…';
    onState?.('loading', elements.status.textContent);
    try {
      return await (loads ? loads.run(() => controller.loadAndWait()) : controller.loadAndWait());
    } finally {
      queued = false;
      if (controller.state === 'idle' || controller.state === 'error') elements.loadButton.disabled = false;
    }
  };
  elements.stopButton.onclick = () => controller.cancel();
  onState?.('checking', elements.status.textContent);
  return controller;
}
