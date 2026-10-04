import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMController, renderAnswer } from '../src/llm-controller.ts';
import { LoadCoordinator } from '../src/load-coordinator.ts';
import type { ModelCacheAvailability } from '../src/types.ts';
import type { Capability } from '../src/llm-controller.ts';

type FakeNode = {
  nodeType?: string; tagName?: string; textContent: string; href?: string; title?: string; className?: string;
  children?: FakeNode[]; append?: (...nodes: FakeNode[]) => void;
};

function fakeDocument() {
  return {
    activeElement: null as FakeEventTarget | null,
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

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
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

function createHarness(capability: Capability = { supported: true }, cache: ModelCacheAvailability = 'missing', loads?: LoadCoordinator) {
  const worker = new MockWorker();
  const document = fakeDocument();
  const answers = {
    nfcorpus: new FakeEventTarget(document),
    msmarco: new FakeEventTarget(document),
  };
  const answerControls = Object.fromEntries(['nfcorpus', 'msmarco'].map(corpus => [corpus, {
    stop: new FakeEventTarget(document), copy: new FakeEventTarget(document), retry: new FakeEventTarget(document), load: new FakeEventTarget(document),
    status: new FakeEventTarget(), feedback: new FakeEventTarget(),
  }])) as Record<'nfcorpus' | 'msmarco', { stop: FakeEventTarget; copy: FakeEventTarget; retry: FakeEventTarget; load: FakeEventTarget; status: FakeEventTarget; feedback: FakeEventTarget }>;
  const elements = {
    setup: new FakeEventTarget(),
    loadButton: new FakeEventTarget(document),
    cancelLoadButton: new FakeEventTarget(document),
    stopButton: new FakeEventTarget(),
    status: new FakeEventTarget(),
    progress: new FakeEventTarget(),
    answers, answerControls,
    searchStatus: new FakeEventTarget(), installedStatus: new FakeEventTarget(), announcement: new FakeEventTarget(),
    generating: { nfcorpus: new FakeEventTarget(), msmarco: new FakeEventTarget() },
  };
  const workers = [worker];
  const workerFactory = vi.fn(() => {
    if (workerFactory.mock.calls.length > 1) workers.push(new MockWorker());
    return workers.at(-1) as unknown as Worker;
  });
  const inspectCache = vi.fn(async () => cache);
  const detectWebGPU = vi.fn(async () => capability);
  const controller = new LLMController({ workerFactory, elements: elements as unknown as ConstructorParameters<typeof LLMController>[0]['elements'], detectWebGPU, inspectCache, loads });
  return { answers, controller, detectWebGPU, elements, worker, workerFactory, inspectCache, workers, currentWorker: () => workers.at(-1)! };
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, elements, worker, currentWorker } = createHarness();
    await controller.initializeCapability();
    expect(elements.setup.hidden).toBe(false);
    expect(elements.status.textContent).toBe('Model not installed');
    expect(elements.loadButton.hidden).toBe(false);
    expect(elements.stopButton.hidden).toBe(true);
    await controller.load(true);
    expect(elements.setup.hidden).toBe(true);
    worker.emit({ type: 'cache-unavailable', operation: 'load', reason: 'missing', message: 'Saved model could not load' });
    expect(controller.repairNeeded).toBe(false);
    expect(warn).toHaveBeenCalledWith('Could not load saved model:', 'Saved model could not load');
    expect(elements.loadButton.textContent).toBe('Download model (~1.84 GB)');
    expect(elements.setup.hidden).toBe(false);
    expect(elements.loadButton.hidden).toBe(false);
    await controller.load();
    currentWorker().emit({ type: 'ready' });
    expect(elements.status.textContent).toBe('Answers ready');
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
    expect(harness.elements.answerControls.msmarco.status.textContent).toContain('Document results are ready');
    expect(harness.answers.nfcorpus.textContent).toBe('');
  });

  it('loads explicitly once and shares the same worker across both corpora', async () => {
    const { controller, elements, worker, workerFactory } = createHarness();

    await controller.initializeCapability();
    expect(workerFactory).not.toHaveBeenCalled();

    await controller.load();
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: 'load', loadId: 1 }));
    worker.emit({ type: 'progress', progress: { progress: 50, total: 100, file: 'model.onnx' } });
    expect(elements.status.textContent).toContain('Downloading model');
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
    expect(elements.answerControls.msmarco.status.textContent).toBe('Generating answer…');

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
    expect(elements.answerControls.msmarco.status.textContent).toBe('Answer generated using 1 passage.');
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
    expect(elements.answerControls.nfcorpus.status.textContent).toBe('Answer generated using 2 documents.');
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
    expect(elements.answerControls.nfcorpus.status.textContent).toBe('Answer generation failed. Retry answer.');
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
    expect(elements.answerControls.nfcorpus.status.textContent).toBe('Answer generated using 1 document.');
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

    expect(elements.status.textContent).toMatch(/could not load/i);
    expect(elements.loadButton.disabled).toBe(false);

    await controller.load();
    expect(controller.ensureWorker()).not.toBe(worker);
    expect(worker.terminated).toBe(true);
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

it('offers answer retry without blaming installed files for a generation failure', async () => {
  const { controller, elements, worker } = await readyHarness();
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({ type: 'error', operation: 'generate', requestId: controller.activeRequest!.id, message: 'GPU failure' });
  expect(controller.repairNeeded).toBe(false);
  expect(elements.answerControls.nfcorpus.status.textContent).toBe('Answer generation failed. Retry answer.');
  expect(elements.answerControls.nfcorpus.retry.hidden).toBe(false);
});

it('flags the model card for repair after confirmed corruption and clears it once the model works again', async () => {
  const { controller, elements, worker } = await readyHarness();
  const card = { toggleAttribute: vi.fn() };
  (elements as { modelCard?: unknown }).modelCard = card;
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({ type: 'error', operation: 'generate', requestId: controller.activeRequest!.id, reason: 'corrupt', message: 'Invalid cached metadata' });
  expect(card.toggleAttribute).toHaveBeenLastCalledWith('data-repair', true);
  controller.generate({ corpus: 'nfcorpus', question: 'test', documents: [], citationTargets: new Map() });
  worker.emit({ type: 'complete', requestId: controller.activeRequest!.id, answer: 'Answer', documentIds: [] });
  expect(card.toggleAttribute).toHaveBeenLastCalledWith('data-repair', false);
});

const evidence = [{ id: 'MED-1', title: 'Evidence', text: 'A supported fact.' }];
const answerOptions = { corpus: 'nfcorpus' as const, question: 'question', documents: evidence, citationTargets: new Map([['MED-1', '#doc-1']]) };

it('continues the latest waiting answer exactly once when cached loading finishes', async () => {
  const { controller, worker, elements } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  const loading = controller.loadAndWait(true);
  await vi.waitFor(() => expect(worker.messages.some(m => m.type === 'load')).toBe(true));
  const first = controller.beginRetrieval('nfcorpus');
  controller.generate({ ...answerOptions, question: 'superseded', searchToken: first });
  expect(elements.answerControls.nfcorpus.status.textContent).toBe('Waiting for the model…');
  const latest = controller.beginRetrieval('nfcorpus');
  controller.generate({ ...answerOptions, question: 'latest', searchToken: latest });
  const load = worker.messages.find(m => m.type === 'load')!;
  worker.emit({ type: 'ready', loadId: load.loadId });
  worker.emit({ type: 'ready', loadId: load.loadId });
  await loading;
  expect(worker.messages.filter(m => m.type === 'generate')).toHaveLength(1);
  expect(worker.messages.find(m => m.type === 'generate')?.question).toBe('latest');
});

it.each(['stop', 'switch', 'home'] as const)('does not revive a waiting answer after %s', async action => {
  const { controller, worker } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  await controller.load(true);
  const token = controller.beginRetrieval('nfcorpus');
  controller.generate({ ...answerOptions, searchToken: token });
  if (action === 'stop') controller.cancel();
  else if (action === 'switch') controller.invalidateSearch();
  else controller.resetAnswers();
  worker.emit({ type: 'ready', loadId: worker.messages[0].loadId });
  expect(worker.messages.some(m => m.type === 'generate')).toBe(false);
  if (action !== 'stop') expect(controller.generate({ ...answerOptions, searchToken: token })).toBe(false);
});

it('keeps partial text and citations, saves stopped text once, copies it, and retries the same evidence', async () => {
  const { controller, worker, answers, elements } = await readyHarness();
  const complete = vi.fn();
  const stopped = vi.fn();
  controller.generate({ ...answerOptions, onComplete: complete, onStopped: stopped });
  const first = controller.activeRequest!.id;
  worker.emit({ type: 'context', requestId: first, documentIds: ['MED-1'] });
  worker.emit({ type: 'answer-delta', requestId: first, text: 'Partial [MED-1]' });
  controller.cancel();
  controller.cancel();
  expect(stopped).toHaveBeenCalledExactlyOnceWith('Partial [MED-1]', ['MED-1']);
  expect(elements.answerControls.nfcorpus.status.textContent).toBe('Stopped');
  expect(links(answers.nfcorpus).map(link => link.href)).toEqual(['#doc-1']);
  const writeText = vi.fn(async () => {});
  expect(await controller.copyAnswer('nfcorpus', { writeText })).toBe(true);
  expect(writeText).toHaveBeenCalledWith('Partial [MED-1]');
  expect(elements.answerControls.nfcorpus.feedback.textContent).toBe('Copied');
  expect(await controller.copyAnswer('nfcorpus', { writeText: async () => { throw new Error('denied'); } })).toBe(false);
  expect(elements.answerControls.nfcorpus.feedback.textContent).toContain('Select the answer text');
  controller.retryAnswer('nfcorpus');
  const next = controller.activeRequest!.id;
  expect(next).not.toBe(first);
  expect(worker.messages.filter(m => m.type === 'generate').at(-1)).toMatchObject({ question: 'question', documents: evidence });
  worker.emit({ type: 'answer-delta', requestId: first, text: ' stale' });
  worker.emit({ type: 'complete', requestId: next, answer: 'Final [MED-1]', documentIds: ['MED-1'] });
  expect(complete).toHaveBeenCalledExactlyOnceWith('Final [MED-1]', ['MED-1']);
  expect(stopped).toHaveBeenCalledOnce();
});

it('does not save or copy a stopped answer before any text is generated', async () => {
  const { controller } = await readyHarness();
  const stopped = vi.fn();
  controller.generate({ ...answerOptions, onStopped: stopped });
  controller.cancel();
  expect(stopped).not.toHaveBeenCalled();
  expect(await controller.copyAnswer('nfcorpus', { writeText: vi.fn() })).toBe(false);
});

it('cancels a queued load before creating a worker and releases the coordinator', async () => {
  const loads = new LoadCoordinator();
  let release!: () => void;
  const blocker = loads.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const { controller, workerFactory } = createHarness({ supported: true }, 'installed', loads);
  await controller.initializeCapability();
  const loading = controller.loadAndWait(true);
  expect(controller.model.stage).toBe('queued');
  expect(controller.cancelLoad()).toBe(true);
  release();
  await Promise.all([blocker, loading]);
  expect(workerFactory).not.toHaveBeenCalled();
  expect(controller.state).toBe('idle');
  await expect(loads.run(async () => 42)).resolves.toBe(42);
});

it('cancels an active load, rejects old worker events, and retries with a new cached worker', async () => {
  const { controller, worker, currentWorker, workerFactory } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  const loading = controller.loadAndWait(true);
  await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
  const first = worker.messages[0].loadId;
  controller.cancelLoad();
  await loading;
  await controller.load(true);
  const next = currentWorker();
  expect(workerFactory).toHaveBeenCalledTimes(2);
  expect(worker.terminated).toBe(true);
  worker.emit({ type: 'ready', loadId: first });
  next.emit({ type: 'ready', loadId: first });
  expect(controller.state).toBe('loading');
  next.emit({ type: 'ready', loadId: next.messages[0].loadId });
  expect(controller.state).toBe('ready');
  expect(next.messages[0]).toMatchObject({ cachedOnly: true });
});

it.each([
  ['missing', 'Model not installed', 'Download model (~1.84 GB)'],
  ['incomplete', 'Model install incomplete', 'Download missing files'],
  ['installed', 'Model installed · Not loaded', 'Load saved model'],
  ['corrupt', 'Some saved model files are invalid.', 'Download missing files'],
  ['unknown', 'Could not check model files', 'Load saved model'],
] as const)('separates %s files from runtime readiness', async (cache, status, action) => {
  const { controller, elements } = createHarness({ supported: true }, cache);
  await controller.initializeCapability();
  expect(elements.searchStatus.textContent).toBe(status);
  expect(elements.loadButton.textContent).toBe(action);
  expect(controller.ready).toBe(false);
});

it('keeps download bytes indeterminate and announces stages rather than byte updates', async () => {
  const { controller, worker, elements } = createHarness();
  await controller.initializeCapability();
  await controller.load();
  const loadId = worker.messages[0].loadId;
  worker.emit({ type: 'progress', loadId, progress: { stage: 'downloading', downloadedBytes: 2048 } });
  expect(elements.searchStatus.textContent).toBe('Downloaded 2.0 KB');
  expect(elements.progress.value).toBeUndefined();
  expect(elements.announcement.textContent).toBe('Downloading model…');
  worker.emit({ type: 'progress', loadId, progress: { stage: 'downloading', downloadedBytes: 4096 } });
  expect(elements.searchStatus.textContent).toBe('Downloaded 4.0 KB');
  expect(elements.announcement.textContent).toBe('Downloading model…');
  worker.emit({ type: 'progress', loadId, progress: { stage: 'initializing', downloadedBytes: 4096 } });
  expect(elements.searchStatus.textContent).toBe('Initializing model…');
});

it('blocks a waiting answer after cache failure without downloading automatically', async () => {
  const { controller, worker, elements } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  await controller.load(true);
  controller.generate(answerOptions);
  worker.emit({ type: 'cache-unavailable', loadId: worker.messages[0].loadId, reason: 'incomplete', message: 'Missing weights' });
  expect(elements.answerControls.nfcorpus.load.textContent).toBe('Download missing files');
  expect(elements.answerControls.nfcorpus.load.hidden).toBe(false);
  expect(worker.messages).toHaveLength(1);
});

it('retries initialization with a fresh cached worker and continues the same evidence', async () => {
  const { controller, worker, currentWorker, elements } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  await controller.load(true);
  controller.generate(answerOptions);
  worker.emit({ type: 'cache-unavailable', loadId: worker.messages[0].loadId, reason: 'initialization', message: 'GPU allocation failed' });
  expect(elements.answerControls.nfcorpus.load.textContent).toBe('Retry loading');
  expect(controller.repairNeeded).toBe(false);
  controller.retryAnswer('nfcorpus');
  await vi.waitFor(() => expect(currentWorker()).not.toBe(worker));
  const retry = currentWorker();
  expect(retry.messages[0]).toMatchObject({ type: 'load', cachedOnly: true });
  expect(worker.terminated).toBe(true);
  retry.emit({ type: 'ready', loadId: retry.messages[0].loadId });
  expect(retry.messages.filter(message => message.type === 'generate')).toHaveLength(1);
  expect(retry.messages.at(-1)).toMatchObject({ question: 'question', documents: evidence });
});

it('releases coordinated loading and offers retry if worker construction fails', async () => {
  const loads = new LoadCoordinator();
  const { controller, workerFactory, elements } = createHarness({ supported: true }, 'installed', loads);
  await controller.initializeCapability();
  workerFactory.mockImplementation(() => { throw new Error('Worker unavailable'); });
  await controller.loadAndWait(true);
  expect(controller.state).toBe('error');
  expect(elements.loadButton.textContent).toBe('Retry loading');
  await expect(loads.run(async () => 'released')).resolves.toBe('released');
});

it('does not display Copy feedback for an answer replaced while copying', async () => {
  const { controller, worker, elements } = await readyHarness();
  controller.generate(answerOptions);
  worker.emit({ type: 'complete', requestId: controller.activeRequest!.id, answer: 'Old answer', documentIds: [] });
  let finish!: () => void;
  const copying = controller.copyAnswer('nfcorpus', { writeText: () => new Promise(resolve => { finish = resolve; }) });
  controller.beginRetrieval('nfcorpus');
  finish();
  await copying;
  expect(elements.answerControls.nfcorpus.feedback.textContent).toBe('');
});

it('moves keyboard focus to available controls before the current control disappears', async () => {
  const { controller, elements, worker } = createHarness({ supported: true }, 'installed');
  await controller.initializeCapability();
  elements.loadButton.focus();
  await controller.load(true);
  expect(elements.loadButton.ownerDocument!.activeElement).toBe(elements.cancelLoadButton);
  controller.cancelLoad();
  expect(elements.loadButton.ownerDocument!.activeElement).toBe(elements.loadButton);
  await controller.load(true);
  const current = controller.ensureWorker() as unknown as MockWorker;
  current.emit({ type: 'ready', loadId: current.messages[0].loadId });
  controller.generate(answerOptions);
  elements.answerControls.nfcorpus.stop.focus();
  controller.cancel();
  expect(elements.loadButton.ownerDocument!.activeElement).toBe(elements.answerControls.nfcorpus.retry);
  controller.retryAnswer('nfcorpus');
  expect(elements.loadButton.ownerDocument!.activeElement).toBe(elements.answerControls.nfcorpus.stop);
  current.emit({ type: 'answer-delta', requestId: controller.activeRequest!.id, text: 'Partial' });
  controller.cancel();
  expect(elements.loadButton.ownerDocument!.activeElement).toBe(elements.answerControls.nfcorpus.copy);
  expect(worker.terminated).toBe(true);
});
