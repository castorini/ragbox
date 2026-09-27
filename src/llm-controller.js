export async function detectWebGPU() {
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
  return new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
}

function progressPercent(progress) {
  if (Number.isFinite(progress?.progress)) return Math.min(100, Math.max(0, progress.progress));
  if (Number.isFinite(progress?.loaded) && Number.isFinite(progress?.total) && progress.total > 0) {
    return Math.min(100, Math.max(0, progress.loaded / progress.total * 100));
  }
  return null;
}

function citationTargetMap(citationTargets) {
  if (citationTargets instanceof Map) {
    return new Map([...citationTargets].map(([id, target]) => [String(id), String(target)]));
  }
  return new Map(Object.entries(citationTargets ?? {}).map(([id, target]) => [String(id), String(target)]));
}

export function renderAnswer(container, text, citationTargets = new Map()) {
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
      link.href = targets.get(id);
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
  constructor({
    elements,
    workerFactory = defaultWorkerFactory,
    detectWebGPU: capabilityDetector = detectWebGPU,
  }) {
    this.elements = elements;
    this.workerFactory = workerFactory;
    this.capabilityDetector = capabilityDetector;
    this.worker = null;
    this.capability = null;
    this.state = 'checking';
    this.activeRequest = null;
    this.requestNumber = 0;
    this.answers = elements.answers ?? { nfcorpus: elements.answer };
  }

  get ready() {
    return this.state === 'ready' || this.state === 'generating';
  }

  async initializeCapability() {
    this.state = 'checking';
    this.elements.loadButton.disabled = true;
    this.elements.stopButton.disabled = true;
    this.elements.status.textContent = 'Checking WebGPU support…';
    try {
      this.capability = await this.capabilityDetector();
    } catch (error) {
      this.capability = { supported: false, reason: error.message };
    }
    if (!this.capability.supported) {
      this.state = 'unsupported';
      this.elements.status.textContent = `${this.capability.reason} BM25 search remains available.`;
      this.elements.loadButton.disabled = true;
      return this.capability;
    }
    this.state = 'idle';
    this.elements.status.textContent = 'WebGPU is ready. Load the local model when you want cited answers.';
    this.elements.loadButton.disabled = false;
    return this.capability;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = this.workerFactory();
    this.worker.onmessage = event => this.handleMessage(event.data);
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

  async load() {
    if (!this.capability) await this.initializeCapability();
    if (!this.capability?.supported || this.state === 'loading' || this.ready) return false;
    this.state = 'loading';
    this.elements.loadButton.disabled = true;
    this.elements.stopButton.disabled = true;
    this.elements.progress.hidden = false;
    this.elements.progress.removeAttribute?.('value');
    this.elements.status.textContent = 'Starting the local model download…';
    this.ensureWorker().postMessage({ type: 'load' });
    return true;
  }

  answerFor(corpus) {
    const answer = this.answers[corpus];
    if (!answer) throw new Error(`No answer destination is configured for ${corpus}.`);
    return answer;
  }

  beginRetrieval(corpus) {
    if (this.activeRequest) this.cancel(true);
    renderAnswer(this.answerFor(corpus), '');
  }

  generate({ corpus, question, documents, citationTargets, evidenceLabel = 'documents' }) {
    const answer = this.answerFor(corpus);
    if (!this.ready || this.state === 'loading') {
      const message = this.state === 'unsupported'
        ? 'BM25 results are ready. Local answer generation is unavailable on this device.'
        : 'BM25 results are ready. Load the local LLM to generate an answer from the retrieved evidence.';
      renderAnswer(answer, message);
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
    this.ensureWorker().postMessage({
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

  showRetrievalMessage(corpus, message) {
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
    return true;
  }

  handleMessage(message) {
    if (message.type === 'progress' && this.state === 'loading') {
      const percent = progressPercent(message.progress);
      const file = message.progress?.file ? ` ${message.progress.file}` : '';
      if (percent === null) {
        this.elements.progress.removeAttribute?.('value');
        this.elements.status.textContent = `Loading model${file}…`;
      } else {
        this.elements.progress.max = 100;
        this.elements.progress.value = percent;
        this.elements.status.textContent = `Loading model${file}… ${percent.toFixed(0)}%`;
      }
      return;
    }
    if (message.type === 'ready') {
      this.state = 'ready';
      this.elements.progress.hidden = true;
      this.elements.loadButton.disabled = true;
      this.elements.stopButton.disabled = true;
      this.elements.status.textContent = 'Local MiniCPM5-2B model ready. Searches will now generate cited answers.';
      return;
    }
    if (message.requestId && message.requestId !== this.activeRequest?.id) return;
    if (message.type === 'context') {
      const included = new Set((message.documentIds ?? []).map(String));
      this.activeRequest.includedTargets = new Map(
        [...this.activeRequest.citationTargets].filter(([id]) => included.has(id)),
      );
      renderAnswer(
        this.activeRequest.answer,
        this.activeRequest.answerText,
        this.activeRequest.includedTargets,
      );
      return;
    }
    if (message.type === 'answer-delta') {
      this.activeRequest.answerText += message.text;
      renderAnswer(
        this.activeRequest.answer,
        this.activeRequest.answerText,
        this.activeRequest.includedTargets,
      );
      return;
    }
    if (message.type === 'complete') {
      if (!String(message.answer ?? '').trim()) {
        this.handleMessage({
          type: 'error',
          operation: 'generate',
          requestId: message.requestId,
          message: 'The model stopped before producing an answer. Please retry the search.',
        });
        return;
      }
      const request = this.activeRequest;
      const included = new Set((message.documentIds ?? []).map(String));
      request.includedTargets = new Map(
        [...request.citationTargets].filter(([id]) => included.has(id)),
      );
      request.answerText = message.answer;
      renderAnswer(request.answer, request.answerText, request.includedTargets);
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
      if (message.operation === 'load') {
        this.state = 'error';
        this.elements.progress.hidden = true;
        this.elements.loadButton.disabled = false;
        this.elements.status.textContent = `Model load failed: ${message.message}. You can retry.`;
      } else {
        this.activeRequest = null;
        this.state = 'ready';
        this.elements.stopButton.disabled = true;
        this.elements.status.textContent = `Answer generation failed: ${message.message}. BM25 results remain available.`;
      }
    }
  }

  dispose() {
    if (this.activeRequest) this.cancel(true);
    this.worker?.terminate();
    this.worker = null;
  }
}

export function setupLLM() {
  const elements = {
    loadButton: document.querySelector('#llm-load'),
    stopButton: document.querySelector('#llm-stop'),
    status: document.querySelector('#llm-status'),
    progress: document.querySelector('#llm-progress'),
    answers: {
      nfcorpus: document.querySelector('#fts-answer'),
      msmarco: document.querySelector('#marco-answer'),
    },
  };
  const controller = new LLMController({ elements });
  elements.loadButton.onclick = () => controller.load();
  elements.stopButton.onclick = () => controller.cancel();
  controller.initializeCapability();
  return controller;
}
