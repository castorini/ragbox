import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMController, renderAnswer } from '../src/llm-controller.ts';
import type { Capability } from '../src/llm-controller.ts';

type FakeNode = {
  nodeType?: string; tagName?: string; textContent: string; href?: string; title?: string; className?: string;
  children?: FakeNode[]; append?: (...nodes: FakeNode[]) => void;
};

function fakeDocument() {
  return {
    createTextNode: (text: string): FakeNode => ({ nodeType: 'text', textContent: text }),
    createElement: (tagName: string): FakeNode => ({
      tagName, textContent: '', href: '', title: '', children: [],
      append(...nodes: FakeNode[]) { this.children!.push(...nodes); },
    }),
  };
}

class FakeEventTarget {
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  value: number | undefined;
  max: number;
  children: FakeNode[];
  ownerDocument: ReturnType<typeof fakeDocument> | null;
  listeners: Map<string, Array<(event: { type: string; target: FakeEventTarget }) => void>>;

  constructor(ownerDocument: ReturnType<typeof fakeDocument> | null = null) {
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.value = 0;
    this.max = 100;
    this.children = [];
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
  }

  addEventListener(type: string, listener: (event: { type: string; target: FakeEventTarget }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { type: string; target: FakeEventTarget }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
  }

  removeAttribute(name: string) {
    if (name === 'value') this.value = undefined;
  }

  replaceChildren(...children: FakeNode[]) {
    this.children = children;
    this.textContent = children.map(child => child.textContent).join('');
  }
}

class MockWorker {
  messages: Array<{ type: string; requestId?: string; [key: string]: unknown }>;
  onmessage: ((event: { data: unknown }) => void) | null;
  terminated: boolean;

  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.terminated = false;
  }

  postMessage(message: { type: string; requestId?: string; [key: string]: unknown }) {
    this.messages.push(message);
  }

  emit(data: unknown) {
    this.onmessage?.({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

function createHarness(capability: Capability = { supported: true }) {
  const worker = new MockWorker();
  const document = fakeDocument();
  const answers = {
    nfcorpus: new FakeEventTarget(document),
    msmarco: new FakeEventTarget(document),
  };
  const elements = {
    setup: new FakeEventTarget(),
    loadButton: new FakeEventTarget(),
    stopButton: new FakeEventTarget(),
    status: new FakeEventTarget(),
    progress: new FakeEventTarget(),
    answers,
    generating: { nfcorpus: new FakeEventTarget(), msmarco: new FakeEventTarget() },
  };
  const workerFactory = vi.fn(() => worker as unknown as Worker);
  const detectWebGPU = vi.fn(async () => capability);
  const controller = new LLMController({ workerFactory, elements: elements as unknown as ConstructorParameters<typeof LLMController>[0]['elements'], detectWebGPU });
  return { answers, controller, detectWebGPU, elements, worker, workerFactory };
}

async function readyHarness(capability?: Capability) {
  const harness = createHarness(capability);
  await harness.controller.initializeCapability();
  await harness.controller.load();
  harness.worker.emit({ type: 'ready' });
  return harness;
}

function links(container: FakeEventTarget) {
  return container.children.filter(node => node.tagName === 'a');
}

describe('LLMController', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows model setup only when it offers a load action and stop only during generation', async () => {
    const { controller, elements, worker } = createHarness();
    await controller.initializeCapability();
    expect(elements.setup.hidden).toBe(false);
    expect(elements.status.textContent).toBe('Not loaded.');
    expect(elements.loadButton.hidden).toBe(false);
    expect(elements.stopButton.hidden).toBe(true);
    await controller.load(true);
    expect(elements.setup.hidden).toBe(true);
    worker.emit({ type: 'cache-unavailable' });
    expect(elements.status.textContent).toContain('download or retry');
    expect(elements.setup.hidden).toBe(false);
    expect(elements.loadButton.hidden).toBe(false);
    await controller.load();
    worker.emit({ type: 'ready' });
    expect(elements.status.textContent).toBe('MiniCPM5-2B ready for cited answers.');
    expect(elements.setup.hidden).toBe(true);
    expect(elements.loadButton.hidden).toBe(true);
    controller.generate({ corpus: 'nfcorpus', question: 'health', documents: [], citationTargets: new Map() });
    expect(elements.stopButton.hidden).toBe(false);
    controller.cancel();
    expect(elements.stopButton.hidden).toBe(true);
  });

  it('holds a coordinated model load until the worker reports a terminal state', async () => {
    const { controller, worker } = createHarness();
    await controller.initializeCapability();
    let finished = false;
    const loading = controller.loadAndWait(true).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    worker.emit({ type: 'cache-unavailable', operation: 'load', message: 'not cached' });
    await loading;
    expect(finished).toBe(true);
  });

  it('keeps both BM25 result sets usable when WebGPU is unsupported', async () => {
    const harness = createHarness({ supported: false, reason: 'WebGPU is unavailable.' });

    await harness.controller.initializeCapability();
    await harness.controller.load();
    const generated = harness.controller.generate({
      corpus: 'msmarco',
      question: 'query',
      documents: [{ id: 'MARCO-12', title: 'Passage 12', text: 'Evidence' }],
      citationTargets: new Map([['MARCO-12', '#marco-result-12']]),
      evidenceLabel: 'passages',
    });

    expect(generated).toBe(false);
    expect(harness.workerFactory).not.toHaveBeenCalled();
    expect(harness.elements.loadButton.disabled).toBe(true);
    expect(harness.elements.setup.hidden).toBe(true);
    expect(harness.elements.stopButton.hidden).toBe(true);
    expect(harness.elements.status.textContent).toMatch(/WebGPU|unavailable|unsupported/i);
    expect(harness.answers.msmarco.textContent).toMatch(/BM25 results are ready/i);
    expect(harness.answers.nfcorpus.textContent).toBe('');
  });

  it('loads explicitly once and shares the same worker across both corpora', async () => {
    const { controller, elements, worker, workerFactory } = createHarness();

    await controller.initializeCapability();
    expect(workerFactory).not.toHaveBeenCalled();

    await controller.load();
    expect(worker.messages).toContainEqual({ type: 'load' });
    worker.emit({ type: 'progress', progress: { progress: 50, total: 100, file: 'model.onnx' } });
    expect(elements.status.textContent).toMatch(/50|model\.onnx|download/i);
    worker.emit({ type: 'ready' });

    controller.generate({
      corpus: 'nfcorpus',
      question: 'first',
      documents: [{ id: 'MED-14', title: 'One', text: 'First' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    controller.generate({
      corpus: 'msmarco',
      question: 'second',
      documents: [{ id: 'MARCO-12', title: 'Passage 12', text: 'Second' }],
      citationTargets: new Map([['MARCO-12', '#marco-result-12']]),
      evidenceLabel: 'passages',
    });

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(worker.messages.filter(message => message.type === 'generate')).toHaveLength(2);
    expect(elements.loadButton.disabled).toBe(true);
  });

  it('routes output to the request destination, links only fitted evidence, and ignores stale cross-corpus output', async () => {
    const { answers, controller, elements, worker } = await readyHarness();

    controller.generate({
      corpus: 'nfcorpus',
      question: 'first',
      documents: [{ id: 'MED-14', title: 'One', text: 'First' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    const first = worker.messages.find(message => message.type === "generate")!;
    worker.emit({ type: 'context', requestId: first.requestId, documentIds: ['MED-14'] });
    worker.emit({ type: 'answer-delta', requestId: first.requestId, text: 'Current [MED-14].' });
    expect(answers.nfcorpus.textContent).toBe('Current [MED-14].');
    expect(links(answers.nfcorpus).map(link => link.href)).toEqual(['#fts-result-MED-14']);

    controller.generate({
      corpus: 'msmarco',
      question: 'second',
      documents: [
        { id: 'MARCO-12', title: 'Passage 12', text: 'Second' },
        { id: 'MARCO-99', title: 'Passage 99', text: 'Lower ranked' },
      ],
      citationTargets: new Map([
        ['MARCO-12', '#marco-result-12'],
        ['MARCO-99', '#marco-result-99'],
      ]),
      evidenceLabel: 'passages',
    });
    const second = worker.messages.filter(message => message.type === 'generate').at(-1)!;
    expect(second.requestId).not.toBe(first.requestId);
    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: first.requestId });
    expect(elements.status.textContent).toBe('Generating an answer from MS MARCO evidence locally…');

    worker.emit({ type: 'answer-delta', requestId: first.requestId, text: ' stale' });
    worker.emit({
      type: 'complete',
      requestId: first.requestId,
      answer: 'Stale replacement [MED-14].',
      documentIds: ['MED-14'],
    });
    expect(answers.nfcorpus.textContent).toBe('Current [MED-14].');
    expect(answers.msmarco.textContent).toBe('');

    worker.emit({ type: 'context', requestId: second.requestId, documentIds: ['MARCO-12'] });
    worker.emit({
      type: 'answer-delta',
      requestId: second.requestId,
      text: 'Fresh [MARCO-12], excluded [MARCO-99].',
    });
    expect(answers.nfcorpus.textContent).toBe('Current [MED-14].');
    expect(answers.msmarco.textContent).toBe('Fresh [MARCO-12], excluded [MARCO-99].');
    expect(links(answers.msmarco).map(link => [link.textContent, link.href])).toEqual([
      ['[MARCO-12]', '#marco-result-12'],
    ]);

    worker.emit({
      type: 'complete',
      requestId: second.requestId,
      answer: 'Fresh [MARCO-12], excluded [MARCO-99].',
      documentIds: ['MARCO-12'],
    });
    expect(elements.status.textContent).toBe('Answer generated using 1 passage.');
    expect(links(answers.msmarco).map(link => link.href)).toEqual(['#marco-result-12']);
  });

  it('uses the fitted IDs on completion even if no context message arrived', async () => {
    const { answers, controller, elements, worker } = await readyHarness();

    controller.generate({
      corpus: 'nfcorpus',
      question: 'question',
      documents: [
        { id: 'MED-14', title: 'One', text: 'Evidence' },
        { id: 'MED-2', title: 'Two', text: 'More evidence' },
        { id: 'MED-99', title: 'Three', text: 'Excluded by budget' },
      ],
      citationTargets: {
        'MED-14': '#fts-result-MED-14',
        'MED-2': '#fts-result-MED-2',
        'MED-99': '#fts-result-MED-99',
      },
      evidenceLabel: 'documents',
    });
    const request = worker.messages.find(message => message.type === "generate")!;
    worker.emit({
      type: 'complete',
      requestId: request.requestId,
      answer: 'Included [MED-14] [MED-2]. Excluded [MED-99].',
      documentIds: ['MED-14', 'MED-2'],
    });

    expect(links(answers.nfcorpus).map(link => link.href)).toEqual([
      '#fts-result-MED-14',
      '#fts-result-MED-2',
    ]);
    expect(elements.status.textContent).toBe('Answer generated using 2 documents.');
  });

  it('cancels explicitly and suppresses late output from the cancelled request', async () => {
    const { answers, controller, elements, worker } = await readyHarness();
    controller.generate({
      corpus: 'nfcorpus',
      question: 'question',
      documents: [{ id: 'MED-14', title: 'One', text: 'Evidence' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    const request = worker.messages.find(message => message.type === "generate")!;

    controller.cancel();
    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId });

    worker.emit({ type: 'answer-delta', requestId: request.requestId, text: 'too late' });
    worker.emit({ type: 'complete', requestId: request.requestId, answer: 'too late' });
    expect(answers.nfcorpus.textContent).not.toContain('too late');
    expect(elements.stopButton.disabled).toBe(true);
  });

  it.each(['', '   '])('reports empty generation as a failure, not insufficient evidence (%j)', async answer => {
    const { answers, controller, elements, worker } = await readyHarness();
    controller.generate({
      corpus: 'nfcorpus',
      question: 'unanswerable',
      documents: [{ id: 'MED-14', title: 'One', text: 'Evidence' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    const request = worker.messages.find(message => message.type === "generate")!;

    worker.emit({ type: 'complete', requestId: request.requestId, answer, documentIds: ['MED-14'] });

    expect(answers.nfcorpus.textContent).not.toMatch(/do not contain enough information/i);
    expect(elements.status.textContent).toMatch(/failed.*before producing an answer/i);
    expect(elements.stopButton.disabled).toBe(true);
    expect(controller.state).toBe('ready');
    expect(controller.activeRequest).toBeNull();
  });

  it('preserves an explicit insufficient-evidence answer from the model', async () => {
    const { answers, controller, elements, worker } = await readyHarness();
    controller.generate({
      corpus: 'nfcorpus',
      question: 'unanswerable',
      documents: [{ id: 'MED-14', title: 'One', text: 'Evidence' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    const request = worker.messages.find(message => message.type === "generate")!;
    const answer = 'The retrieved documents do not contain enough information to answer this question.';

    worker.emit({ type: 'complete', requestId: request.requestId, answer, documentIds: ['MED-14'] });

    expect(answers.nfcorpus.textContent).toBe(answer);
    expect(elements.status.textContent).toBe('Answer generated using 1 document.');
  });

  it('clears the new corpus destination and cancels the active generation at retrieval start', async () => {
    const { answers, controller, worker } = await readyHarness();
    renderAnswer(answers.nfcorpus as unknown as HTMLElement, 'Previous NFCorpus answer.');
    renderAnswer(answers.msmarco as unknown as HTMLElement, 'Previous MS MARCO answer.');
    controller.generate({
      corpus: 'nfcorpus',
      question: 'question',
      documents: [{ id: 'MED-14', title: 'One', text: 'Evidence' }],
      citationTargets: new Map([['MED-14', '#fts-result-MED-14']]),
    });
    const request = worker.messages.find(message => message.type === "generate")!;

    controller.beginRetrieval('msmarco');

    expect(worker.messages).toContainEqual({ type: 'cancel', requestId: request.requestId });
    expect(answers.msmarco.textContent).toBe('');
    expect(answers.nfcorpus.textContent).toBe('');
  });

  it('allows retry after a model-load error and terminates its worker on disposal', async () => {
    const { controller, elements, worker } = createHarness();
    await controller.initializeCapability();
    await controller.load();
    worker.emit({ type: 'error', operation: 'load', message: 'download failed' });

    expect(elements.status.textContent).toMatch(/download failed/i);
    expect(elements.loadButton.disabled).toBe(false);

    await controller.load();
    expect(worker.messages.filter(message => message.type === 'load')).toHaveLength(2);
    controller.dispose();
    expect(worker.terminated).toBe(true);
  });
});

describe('renderAnswer', () => {
  it('uses exact per-request anchors, links only mapped citations, and never parses model HTML', () => {
    const container = new FakeEventTarget(fakeDocument());

    renderAnswer(
      container as unknown as HTMLElement,
      '<b>Claim</b> [MED-14], passage [MARCO-12], and unknown [MED-404].',
      new Map([
        ['MED-14', '#fts-result-MED-14'],
        ['MARCO-12', '#marco-result-12'],
      ]),
    );

    expect(links(container).map(link => [link.textContent, link.href, link.title])).toEqual([
      ['[MED-14]', '#fts-result-MED-14', 'Jump to retrieved evidence MED-14'],
      ['[MARCO-12]', '#marco-result-12', 'Jump to retrieved evidence MARCO-12'],
    ]);
    expect(container.children.filter(node => node.tagName)).toHaveLength(2);
    expect(container.textContent).toBe(
      '<b>Claim</b> [MED-14], passage [MARCO-12], and unknown [MED-404].',
    );
  });
});

it('shows the generating indicator only for the active corpus and clears it on completion, error, or cancel', async () => {
  const { controller, elements, worker } = await readyHarness();
  const start = () => controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  start();
  expect(elements.generating.nfcorpus.hidden).toBe(false);
  expect(elements.generating.msmarco.hidden).toBe(true);
  worker.emit({ type: 'complete', requestId: controller.activeRequest!.id, answer: 'Answer', documentIds: [] });
  expect(elements.generating.nfcorpus.hidden).toBe(true);
  start();
  worker.emit({ type: 'error', operation: 'generate', requestId: controller.activeRequest!.id, message: 'Failed' });
  expect(elements.generating.nfcorpus.hidden).toBe(true);
  start();
  controller.cancel();
  expect(elements.generating.nfcorpus.hidden).toBe(true);
});

it('guides the user to repair the model when answer generation fails', async () => {
  const { controller, elements, worker } = await readyHarness();
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({
    type: 'error', operation: 'generate', requestId: controller.activeRequest!.id,
    message: "Cannot read properties of null (reading 'apply_chat_template')",
  });
  const [box] = elements.answers.nfcorpus.children;
  expect(box.className).toBe('answer-repair');
  const [message, link] = box.children!;
  expect(message.textContent).toContain('apply_chat_template');
  expect(message.textContent).toContain('delete the installed model');
  expect(link.href).toBe('?view=setup#model-storage');
  expect(link.textContent).toBe('Repair the model →');
});

it('flags the model card for repair after a failure and clears it once the model works again', async () => {
  const { controller, elements, worker } = await readyHarness();
  const card = { toggleAttribute: vi.fn() };
  (elements as { modelCard?: unknown }).modelCard = card;
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({ type: 'error', operation: 'generate', requestId: controller.activeRequest!.id, message: 'Failed' });
  expect(card.toggleAttribute).toHaveBeenLastCalledWith('data-repair', true);
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({ type: 'complete', requestId: controller.activeRequest!.id, answer: 'Answer', documentIds: [] });
  expect(card.toggleAttribute).toHaveBeenLastCalledWith('data-repair', false);
});
