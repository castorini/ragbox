import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), streamers: [], criteria: [] }));

vi.mock('@huggingface/transformers', () => ({
  pipeline: mocks.pipeline,
  TextStreamer: class {
    constructor(tokenizer, options) {
      this.options = options;
      mocks.streamers.push(this);
    }
  },
  InterruptableStoppingCriteria: class {
    constructor() {
      this.interrupt = vi.fn();
      mocks.criteria.push(this);
    }
  },
}));

const documents = [{ id: 'MED-14', title: 'Evidence', text: 'A useful fact.' }];

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function createHarness({ chunks = ['A useful fact [MED-14].'], final, load } = {}) {
  const generator = vi.fn(async (messages, options) => {
    for (const chunk of chunks) options.streamer.options.callback_function(chunk);
    return [{ generated_text: [...messages, { role: 'assistant', content: final ?? chunks.join('') }] }];
  });
  generator.tokenizer = {
    apply_chat_template: vi.fn(() => 'formatted prompt'),
    encode: vi.fn(() => [1, 2, 3]),
  };
  mocks.pipeline.mockImplementation(async () => {
    if (load) await load;
    return generator;
  });
  const messages = [];
  const worker = { postMessage: message => messages.push(message), onmessage: null };
  vi.stubGlobal('self', worker);
  await import('../src/llm-worker.js');
  const send = data => worker.onmessage({ data });
  const generate = (overrides = {}) => send({
    type: 'generate', requestId: 'request-1', question: 'What is known?', documents, ...overrides,
  });
  const terminal = async (requestId = 'request-1') => {
    await vi.waitFor(() => expect(messages.some(message =>
      message.requestId === requestId && ['complete', 'error', 'cancelled'].includes(message.type),
    )).toBe(true));
    return messages.find(message =>
      message.requestId === requestId && ['complete', 'error', 'cancelled'].includes(message.type),
    );
  };
  return { generator, messages, send, generate, terminal };
}

beforeEach(() => {
  vi.resetModules();
  mocks.pipeline.mockReset();
  mocks.streamers.length = 0;
  mocks.criteria.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('LLM worker generation', () => {
  it('uses the direct-answer template for both budgeting and generation, and streams immediately', async () => {
    const harness = await createHarness({ chunks: ['A useful ', 'fact [MED-14].'] });
    const finish = deferred();
    const originalGenerate = harness.generator.getMockImplementation();
    harness.generator.mockImplementation(async (...args) => {
      const result = await originalGenerate(...args);
      await finish.promise;
      return result;
    });
    harness.generate();

    await vi.waitFor(() => expect(harness.messages.filter(message => message.type === 'answer-delta'))
      .toEqual([
        { type: 'answer-delta', requestId: 'request-1', text: 'A useful ' },
        { type: 'answer-delta', requestId: 'request-1', text: 'fact [MED-14].' },
      ]));
    expect(harness.messages.some(message => message.type === 'complete')).toBe(false);
    expect(harness.generator.tokenizer.apply_chat_template).toHaveBeenCalledWith(
      expect.any(Array), expect.objectContaining({ enable_thinking: false, add_generation_prompt: true }),
    );
    expect(harness.generator).toHaveBeenCalledWith(
      expect.any(Array), expect.objectContaining({ tokenizer_encode_kwargs: { enable_thinking: false } }),
    );
    expect(mocks.streamers[0].options).toMatchObject({ skip_prompt: true, skip_special_tokens: true });

    finish.resolve();
    expect(await harness.terminal()).toMatchObject({
      type: 'complete', answer: 'A useful fact [MED-14].', documentIds: ['MED-14'],
    });
  });

  it('reports fitted context IDs before the first answer delta and repeats them on completion', async () => {
    const fittedDocuments = [
      { id: 'MARCO-1', title: 'Passage 1', text: 'The highest-ranked evidence.' },
      { id: 'MARCO-2', title: 'Passage 2', text: 'Evidence that does not fit.' },
    ];
    const harness = await createHarness({
      chunks: ['Supported answer [MARCO-1].'],
    });
    harness.generator.tokenizer.apply_chat_template.mockImplementation(messages => JSON.stringify(messages));
    harness.generator.tokenizer.encode.mockImplementation(prompt => (
      prompt.includes('MARCO-2') ? new Array(4000).fill(1) : [1]
    ));

    harness.generate({ documents: fittedDocuments });

    expect(await harness.terminal()).toMatchObject({
      type: 'complete',
      requestId: 'request-1',
      documentIds: ['MARCO-1'],
    });
    const contextIndex = harness.messages.findIndex(message => message.type === 'context');
    const deltaIndex = harness.messages.findIndex(message => message.type === 'answer-delta');
    expect(harness.messages[contextIndex]).toEqual({
      type: 'context',
      requestId: 'request-1',
      documentIds: ['MARCO-1'],
    });
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(deltaIndex).toBeGreaterThan(contextIndex);
  });

  it('filters a complete reasoning block from streamed and final answers', async () => {
    const harness = await createHarness({
      chunks: ['<thi', 'nk>private reasoning', '</think>\n\n', 'A useful fact [MED-14].'],
    });
    harness.generate();

    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'A useful fact [MED-14].' });
    expect(harness.messages.filter(message => message.type === 'answer-delta').map(message => message.text).join(''))
      .toBe('A useful fact [MED-14].');
  });

  it.each(['<think>unfinished private reasoning', '<think>private reasoning</think>\n\n', ''])
    ('reports a request error when generation has no final answer: %j', async text => {
      const harness = await createHarness({ chunks: [text] });
      harness.generate();

      expect(await harness.terminal()).toMatchObject({ type: 'error', operation: 'generate', requestId: 'request-1' });
      expect(harness.messages.some(message => ['answer-delta', 'complete'].includes(message.type))).toBe(false);
    });

  it('reports context fitting failure for the request and permits a later generation', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.encode.mockReturnValue(new Array(4000).fill(1));
    harness.generate();

    expect(await harness.terminal()).toMatchObject({
      type: 'error', operation: 'generate', requestId: 'request-1', message: expect.stringMatching(/context|fit/i),
    });
    expect(harness.generator).not.toHaveBeenCalled();

    harness.generator.tokenizer.encode.mockReturnValue([1]);
    harness.generate({ requestId: 'request-2' });
    expect(await harness.terminal('request-2')).toMatchObject({ type: 'complete' });
  });

  it('reports tokenization failures with the request ID', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.apply_chat_template.mockImplementation(() => { throw new Error('bad template'); });
    harness.generate();

    expect(await harness.terminal()).toMatchObject({
      type: 'error', operation: 'generate', requestId: 'request-1', message: 'bad template',
    });
  });

  it('cancels an active generation and suppresses its late answer', async () => {
    const harness = await createHarness();
    const finish = deferred();
    harness.generator.mockImplementation(async (messages, options) => {
      await finish.promise;
      options.streamer.options.callback_function('Late answer');
      return [{ generated_text: [...messages, { role: 'assistant', content: 'Late answer' }] }];
    });
    harness.generate();
    await vi.waitFor(() => expect(harness.generator).toHaveBeenCalled());
    harness.send({ type: 'cancel', requestId: 'request-1' });
    finish.resolve();

    expect(await harness.terminal()).toMatchObject({ type: 'cancelled', requestId: 'request-1' });
    expect(mocks.criteria[0].interrupt).toHaveBeenCalledOnce();
    expect(harness.messages.some(message => ['answer-delta', 'complete'].includes(message.type))).toBe(false);
  });

  it('honors cancellation while the model is still loading', async () => {
    const loaded = deferred();
    const harness = await createHarness({ load: loaded.promise });
    harness.generate();
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalled());
    harness.send({ type: 'cancel', requestId: 'request-1' });
    loaded.resolve();

    expect(await harness.terminal()).toMatchObject({ type: 'cancelled', requestId: 'request-1' });
    expect(harness.generator).not.toHaveBeenCalled();
  });

  it('skips a cancelled queued request and generates its superseding request', async () => {
    const harness = await createHarness();

    harness.generate({ requestId: 'request-queued' });
    harness.send({ type: 'cancel', requestId: 'request-queued' });
    harness.generate({ requestId: 'request-current', question: 'Use the latest search.' });

    expect(await harness.terminal('request-queued')).toEqual({
      type: 'cancelled',
      requestId: 'request-queued',
    });
    expect(await harness.terminal('request-current')).toMatchObject({
      type: 'complete',
      requestId: 'request-current',
      documentIds: ['MED-14'],
    });
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.messages.some(message =>
      message.requestId === 'request-queued' && ['context', 'answer-delta', 'complete'].includes(message.type),
    )).toBe(false);
  });
});
