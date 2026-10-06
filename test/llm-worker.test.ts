import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProgress, WorkerRequest } from '../src/types.ts';
import { MODEL_ID, MODEL_REVISION, MODEL_REMOTE_PATH_TEMPLATE } from '../src/model-cache.ts';
import { ModelCacheError, REQUIRED_MODEL_FILES } from '../src/model-readiness.ts';

type MockMessage = { type: string; query?: string; contextLimited?: boolean; requestId?: string; documentIds?: string[]; text?: string; answer?: string; thinking?: string; loadId?: number; progress?: ModelProgress };
type StreamerOptions = { callback_function: (text: string) => void; token_callback_function?: (tokens: bigint[]) => void; skip_prompt?: boolean; skip_special_tokens?: boolean };
type MockStreamer = { options: StreamerOptions };
type MockGenerationOptions = { streamer?: MockStreamer; stopping_criteria?: Array<{ _call: (ids: number[][]) => boolean[] }> };
type MockChat = Array<{ role: string; content: string }>;
type MockGenerationInput = MockChat | string;
type MockGenerationOutput = { generated_text: MockChat | string };
type MockCriterion = { interrupt: ReturnType<typeof vi.fn> };
type MockEnv = { allowRemoteModels: boolean; allowLocalModels: boolean; fetch: typeof fetch; remotePathTemplate: string };

const mocks = vi.hoisted(() => ({
  env: {} as MockEnv,
  pipeline: vi.fn(),
  requireCache: vi.fn(),
  inspectCache: vi.fn(),
  streamers: [] as MockStreamer[],
  criteria: [] as MockCriterion[],
}));

vi.mock('../src/model-readiness.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/model-readiness.ts')>(),
  requireCompleteModelCache: mocks.requireCache, inspectModelCache: mocks.inspectCache,
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: mocks.pipeline,
  env: mocks.env,
  StoppingCriteria: class { _call(inputIds: number[][]) { return inputIds.map(() => false); } },
  TextStreamer: class {
    options: StreamerOptions;
    constructor(_tokenizer: unknown, options: StreamerOptions) {
      this.options = options;
      mocks.streamers.push(this);
    }
  },
  InterruptableStoppingCriteria: class {
    interrupt: ReturnType<typeof vi.fn>;
    constructor() {
      this.interrupt = vi.fn();
      mocks.criteria.push(this);
    }
  },
}));

const documents = [{ id: 'MED-14', title: 'Evidence', text: 'A useful fact.' }];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(value => { resolve = value; });
  return { promise, resolve };
}

function generatedOutput(input: MockGenerationInput, text: string): MockGenerationOutput[] {
  return [{ generated_text: typeof input === 'string' ? text : [...input, { role: 'assistant', content: text }] }];
}

function exhaustThinking(options: MockGenerationOptions, text: string, limit = 1024) {
  options.streamer!.options.token_callback_function!(new Array<bigint>(limit).fill(9n));
  expect(options.stopping_criteria!.at(-1)!._call([[99]])).toEqual([true]);
  options.streamer!.options.callback_function(text);
}

async function createHarness({ chunks = ['</think>A useful fact [MED-14].'], final, load }: {
  chunks?: string[]; final?: string; load?: Promise<void>;
} = {}) {
  const tokenizer = {
    apply_chat_template: vi.fn((_messages: unknown) => 'formatted prompt'),
    encode: vi.fn((_prompt: string) => [1, 2, 3]),
    decode: vi.fn((ids: number[], _options?: { skip_special_tokens?: boolean }) => ids.map(id => ({ 1: '<', 2: '/think', 3: '>' }[id] ?? 'x')).join('')),
  };
  const generator = Object.assign(vi.fn(async (messages: MockGenerationInput, options: MockGenerationOptions): Promise<MockGenerationOutput[]> => {
    if (options.streamer) for (const chunk of chunks) options.streamer.options.callback_function(chunk);
    return generatedOutput(messages, final ?? chunks.join(''));
  }), { tokenizer, dispose: vi.fn(async () => []) });
  mocks.pipeline.mockImplementation(async () => {
    if (load) await load;
    return generator;
  });
  const messages: MockMessage[] = [];
  const worker: { postMessage: (message: MockMessage) => void; onmessage: ((event: { data: WorkerRequest }) => void) | null } = {
    postMessage: message => { messages.push(message); }, onmessage: null,
  };
  vi.stubGlobal('self', worker);
  await import('../src/llm-worker.ts');
  const send = (data: WorkerRequest) => worker.onmessage?.({ data });
  const generate = (overrides: Partial<Extract<WorkerRequest, { type: 'generate' }>> = {}) => send({
    type: 'generate', requestId: 'request-1', corpus: 'nfcorpus', question: 'What is known?', documents, ...overrides,
  });
  const terminal = async (requestId = 'request-1') => {
    await vi.waitFor(() => expect(messages.some(message =>
      message.requestId === requestId && ['complete', 'resolved-query', 'error', 'cancelled'].includes(message.type),
    )).toBe(true));
    return messages.find(message =>
      message.requestId === requestId && ['complete', 'resolved-query', 'error', 'cancelled'].includes(message.type),
    );
  };
  return { generator, messages, send, generate, terminal };
}

beforeEach(() => {
  vi.resetModules();
  mocks.pipeline.mockReset();
  mocks.env.fetch = vi.fn(async () => new Response(null));
  mocks.requireCache.mockReset().mockResolvedValue(undefined);
  mocks.inspectCache.mockReset().mockResolvedValue({ availability: 'installed', missing: [] });
  mocks.streamers.length = 0;
  mocks.criteria.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('LLM worker generation', () => {
  it('corrects invented final citation IDs once, buffering the repair and preserving the same request', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.apply_chat_template.mockImplementation(messages => JSON.stringify(messages));
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        options.streamer!.options.callback_function('Compare [SOURCE-1].</think>Wrong [SOURCE-1].');
        return generatedOutput(messages, 'Compare [SOURCE-1].</think>Wrong [SOURCE-1].');
      }
      expect(messages).toContain('failed citation validation'); expect(messages).toContain('MED-14');
      expect(messages).not.toContain('SOURCE-1');
      expect(options).toMatchObject({ max_new_tokens: 512, do_sample: false, return_full_text: false, add_special_tokens: false });
      expect(options.streamer).toBeUndefined();
      expect(options.stopping_criteria![0]).toBe(harness.generator.mock.calls[0][1].stopping_criteria![0]);
      expect(harness.messages).toContainEqual({ type: 'answer-reset', requestId: 'request-1' });
      return generatedOutput(messages, 'Correct [MED-14].');
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'Correct [MED-14].', thinking: 'Compare [SOURCE-1].', documentIds: ['MED-14'] });
    expect(harness.generator).toHaveBeenCalledTimes(2);
    expect(harness.messages.filter(message => message.type === 'complete')).toHaveLength(1);
  });
  it.each(['Still wrong [SOURCE-1].', '', 'Broken [MED-14', 'Uncited finding.\n\n[MED-14]', 'An uncited summary remains.'])('rejects an invalid citation correction without looping: %s', async final => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        options.streamer!.options.callback_function('</think>Wrong [SOURCE-1].');
        return generatedOutput(messages, '</think>Wrong [SOURCE-1].');
      }
      return generatedOutput(messages, final);
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'error', message: expect.stringContaining('valid source citations') });
    expect(harness.generator).toHaveBeenCalledTimes(2);
    expect(harness.messages.some(message => message.type === 'complete')).toBe(false);
    expect(harness.messages.filter(message => message.type === 'answer-delta').map(message => message.text).join('')).toBe('Wrong [SOURCE-1].');
  });
  it.each(['Finding.\n\n[MED-14]', 'Finding. Citations: [MED-14].', 'A useful finding without a citation.', 'Uncited opening. Finding [MED-14]. Uncited ending.'])('corrects an unattached or absent citation: %s', async draft => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        options.streamer!.options.callback_function(`</think>${draft}`);
        return generatedOutput(messages, `</think>${draft}`);
      }
      return generatedOutput(messages, 'Finding [MED-14].');
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'Finding [MED-14].' });
    expect(harness.messages).toContainEqual({ type: 'answer-reset', requestId: 'request-1' });
  });
  it('fits the whole correction prompt including its closed thinking prefix within the input budget', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.apply_chat_template.mockImplementation(messages => JSON.stringify(messages));
    harness.generator.tokenizer.encode.mockImplementation(prompt => prompt === '</think>' ? [1, 2, 3] : Array.from({ length: prompt.length }, () => 9));
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        options.streamer!.options.callback_function('</think>Wrong [SOURCE-1].');
        return generatedOutput(messages, '</think>Wrong [SOURCE-1].');
      }
      expect(messages.length).toBeLessThanOrEqual(3500);
      return generatedOutput(messages, 'Correct [MED-14].');
    });
    harness.generate({ documents: [{ ...documents[0], text: 'e'.repeat(5000) }] });
    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'Correct [MED-14].' });
    expect(harness.messages.filter(message => message.type === 'context')).toHaveLength(2);
  });
  it('ignores a late correction after Stop and allows a subsequent request to finish', async () => {
    const harness = await createHarness(); const release = deferred();
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        options.streamer!.options.callback_function('</think>Wrong [SOURCE-1].');
        return generatedOutput(messages, '</think>Wrong [SOURCE-1].');
      }
      await release.promise;
      return generatedOutput(messages, 'Correct [MED-14].');
    });
    harness.generate(); await vi.waitFor(() => expect(harness.generator).toHaveBeenCalledTimes(2));
    harness.send({ type: 'cancel', requestId: 'request-1' }); release.resolve();
    expect(await harness.terminal()).toMatchObject({ type: 'cancelled' });
    expect(harness.messages.some(message => message.type === 'complete')).toBe(false);
    harness.generator.mockImplementation(async messages => generatedOutput(messages, '</think>Fresh [MED-14].'));
    harness.generate({ requestId: 'request-2' });
    expect(await harness.terminal('request-2')).toMatchObject({ type: 'complete', answer: 'Fresh [MED-14].' });
  });
  it.each([
    ['low', 256], ['balanced', 1024], ['high', 2048], [undefined, 1024], ['invalid', 1024],
  ] as const)('enforces effort %s while preserving the separate final-answer allowance', async (effort, limit) => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        expect(options).toMatchObject({ max_new_tokens: limit + 512 });
        const tokens = options.streamer!.options.token_callback_function!;
        const criterion = options.stopping_criteria!.at(-1)!;
        tokens(new Array<bigint>(limit - 1).fill(9n)); expect(criterion._call([[99]])).toEqual([false]);
        tokens([9n]); expect(criterion._call([[99]])).toEqual([true]);
        options.streamer!.options.callback_function('Budgeted reasoning.');
        return generatedOutput(messages, 'Budgeted reasoning.');
      }
      expect(options).toMatchObject({ max_new_tokens: 512 });
      options.streamer!.options.callback_function('Final finding [MED-14].');
      return generatedOutput(messages, 'Final finding [MED-14].');
    });
    harness.generate({ thinkingEffort: effort as Extract<WorkerRequest, { type: 'generate' }>['thinkingEffort'] });
    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'Final finding [MED-14].', thinking: 'Budgeted reasoning.' });
    expect(harness.generator).toHaveBeenCalledTimes(2);
  });
  it('uses thinking mode for budgeting and generation while streaming only final text as the answer', async () => {
    const harness = await createHarness({ chunks: ['Check evidence first.', '</think>A useful ', 'fact [MED-14].'] });
    const finish = deferred();
    const originalGenerate = harness.generator.getMockImplementation();
    harness.generator.mockImplementation(async (...args) => {
      const result = await originalGenerate!(...args);
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
      expect.any(Array), expect.objectContaining({ enable_thinking: true, add_generation_prompt: true }),
    );
    expect(harness.generator).toHaveBeenCalledWith(
      expect.any(Array), expect.objectContaining({ max_new_tokens: 1536, tokenizer_encode_kwargs: { enable_thinking: true } }),
    );
    expect(mocks.streamers[0].options).toMatchObject({ skip_prompt: true, skip_special_tokens: true });
    expect(harness.messages.filter(message => message.type === 'thinking-delta').map(message => message.text).join('')).toBe('Check evidence first.');

    finish.resolve();
    expect(await harness.terminal()).toMatchObject({
      type: 'complete', answer: 'A useful fact [MED-14].', thinking: 'Check evidence first.', documentIds: ['MED-14'],
    });
    expect(harness.generator).toHaveBeenCalledOnce();
  });

  it('reports fitted context IDs before the first answer delta and repeats them on completion', async () => {
    const fittedDocuments = [
      { id: 'MARCO-1', title: 'Passage 1', text: 'The highest-ranked evidence.' },
      { id: 'MARCO-2', title: 'Passage 2', text: 'Evidence that does not fit.' },
    ];
    const harness = await createHarness({
      chunks: ['</think>Supported answer [MARCO-1].'],
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
      contextLimited: false,
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

  it('holds prefilled reasoning across a split closing tag and keeps reasoning citations out of the answer', async () => {
    const harness = await createHarness({ chunks: ['Consider [MED-404].', '</thi', 'nk>', 'Finding [MED-14].'] });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ answer: 'Finding [MED-14].', thinking: 'Consider [MED-404].' });
    expect(harness.messages.filter(message => message.type === 'answer-delta').map(message => message.text).join('')).toBe('Finding [MED-14].');
    expect(harness.messages.filter(message => message.type === 'thinking-delta').map(message => message.text).join('')).toBe('Consider [MED-404].');
  });

  it('stops at the final-answer token cap even when reasoning finishes early', async () => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      const tokens = options.streamer!.options.token_callback_function!;
      const cap = options.stopping_criteria!.at(-1)!;
      tokens([9n, 1n, 2n]); expect(cap._call([[99]])).toEqual([false]);
      tokens([3n]); tokens(new Array(511).fill(9n)); expect(cap._call([[99]])).toEqual([false]);
      tokens([9n]); expect(cap._call([[99]])).toEqual([true]);
      options.streamer!.options.callback_function('Reason.</think>Final [MED-14].');
      return generatedOutput(messages, 'Reason.</think>Final [MED-14].');
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'complete', answer: 'Final [MED-14].' });
  });

  it('finalizes exhausted reasoning with the same question and evidence without promoting reasoning into the answer', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.apply_chat_template.mockImplementation(messages => `${JSON.stringify(messages)}\n<assistant><think>`);
    const thinking = 'Unfinished reasoning [MED-404].';
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        exhaustThinking(options, thinking);
        expect(harness.messages.some(message => message.type === 'answer-delta')).toBe(false);
        return generatedOutput(messages, thinking);
      }
      expect(messages).toContain('What is known?');
      expect(messages).toContain('MED-14');
      expect(messages).toContain('A useful fact.');
      expect(messages).toContain('Previous assistant answers are conversation context, not evidence');
      expect(messages.endsWith(`<assistant><think>${thinking}\n</think>\n\n`)).toBe(true);
      expect(options).toMatchObject({ max_new_tokens: 512, return_full_text: false, add_special_tokens: false });
      expect(options).not.toHaveProperty('tokenizer_encode_kwargs');
      expect(options.stopping_criteria).toHaveLength(1);
      expect(options.stopping_criteria![0]).toBe(harness.generator.mock.calls[0][1].stopping_criteria![0]);
      options.streamer!.options.callback_function('Final finding [MED-14].');
      return generatedOutput(messages, 'Final finding [MED-14].');
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'complete', requestId: 'request-1', answer: 'Final finding [MED-14].', thinking, documentIds: ['MED-14'] });
    expect(harness.generator).toHaveBeenCalledTimes(2);
    expect(harness.messages.filter(message => message.type === 'thinking-delta').map(message => message.text).join('')).toBe(thinking);
    expect(harness.messages.filter(message => message.type === 'answer-delta').map(message => message.text).join('')).toBe('Final finding [MED-14].');
    expect(harness.messages.filter(message => message.type === 'complete')).toHaveLength(1);
    expect(harness.messages.filter(message => message.type === 'context')).toHaveLength(1);
    expect(mocks.streamers).toHaveLength(2);
    expect(mocks.streamers[1].options).toMatchObject({ skip_prompt: true, skip_special_tokens: true });
  });

  it.each(['', '<think>Unfinished extra reasoning [MED-404].'])
    ('exposes Retry when bounded finalization still has no answer: %j', async final => {
      const harness = await createHarness();
      harness.generator.mockImplementation(async (messages, options) => {
        if (typeof messages !== 'string') {
          exhaustThinking(options, 'Initial reasoning.');
          return generatedOutput(messages, 'Initial reasoning.');
        }
        options.streamer!.options.callback_function(final);
        return generatedOutput(messages, final);
      });
      harness.generate();
      expect(await harness.terminal()).toMatchObject({ type: 'error', operation: 'generate', message: expect.stringContaining('Retry answer') });
      expect(harness.generator).toHaveBeenCalledTimes(2);
      expect(harness.messages.some(message => ['answer-delta', 'complete'].includes(message.type))).toBe(false);
    });

  it('cancels after the thinking cap before starting finalization', async () => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      exhaustThinking(options, 'Interrupted reasoning [MED-404].');
      harness.send({ type: 'cancel', requestId: 'request-1' });
      return generatedOutput(messages, 'Interrupted reasoning [MED-404].');
    });
    harness.generate();
    expect(await harness.terminal()).toMatchObject({ type: 'cancelled', requestId: 'request-1' });
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.messages.filter(message => message.type === 'thinking-delta').map(message => message.text).join('')).toBe('Interrupted reasoning [MED-404].');
    expect(harness.messages.some(message => ['answer-delta', 'complete'].includes(message.type))).toBe(false);
    expect(mocks.criteria[0].interrupt).toHaveBeenCalledOnce();
  });

  it('keeps streamed final text separate and suppresses late output when finalization is cancelled', async () => {
    const harness = await createHarness();
    const finish = deferred();
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        exhaustThinking(options, 'Initial comparison [MED-404].');
        return generatedOutput(messages, 'Initial comparison [MED-404].');
      }
      options.streamer!.options.callback_function('Partial final [MED-14].');
      await finish.promise;
      options.streamer!.options.callback_function('<think>Late reasoning</think>Late final.');
      return generatedOutput(messages, 'Partial final [MED-14].<think>Late reasoning</think>Late final.');
    });
    harness.generate();
    await vi.waitFor(() => expect(harness.generator).toHaveBeenCalledTimes(2));
    harness.send({ type: 'cancel', requestId: 'request-1' });
    finish.resolve();
    expect(await harness.terminal()).toMatchObject({ type: 'cancelled', requestId: 'request-1' });
    expect(harness.messages.filter(message => message.type === 'thinking-delta').map(message => message.text).join('')).toBe('Initial comparison [MED-404].');
    expect(harness.messages.filter(message => message.type === 'answer-delta').map(message => message.text).join('')).toBe('Partial final [MED-14].');
    expect(harness.messages.some(message => message.type === 'complete')).toBe(false);
    expect(mocks.criteria[0].interrupt).toHaveBeenCalledOnce();
  });

  it.each(['unfinished prefilled reasoning', '<think>unfinished private reasoning', '<think>private reasoning</think>\n\n', ''])
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
      options.streamer!.options.callback_function('Late answer');
      return generatedOutput(messages, 'Late answer');
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

it('automatically loads cached model files without remote model downloads', async () => {
  const harness = await createHarness();
  harness.send({ type: 'load', cachedOnly: true });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'ready')).toBe(true));
  expect(mocks.env.allowRemoteModels).toBe(false);
  expect(mocks.env.allowLocalModels).toBe(true);
  expect(mocks.env.remotePathTemplate).toBe(MODEL_REMOTE_PATH_TEMPLATE);
});
it('offers a manual retry when the cache is missing, without automatic download fallback', async () => {
  const harness = await createHarness();
  mocks.pipeline.mockRejectedValueOnce(new Error('not cached'));
  harness.send({ type: 'load', cachedOnly: true });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'cache-unavailable')).toBe(true));
  expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  harness.send({ type: 'load' });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'ready')).toBe(true));
  expect(mocks.pipeline.mock.calls[1][2].local_files_only).toBe(false);
});

it('releases an unusable model session before reporting a tokenizer failure and permits retry', async () => {
  const harness = await createHarness();
  const dispose = vi.fn(async () => {});
  mocks.pipeline.mockResolvedValueOnce({ tokenizer: null, dispose });
  harness.send({ type: 'load', cachedOnly: true });
  await vi.waitFor(() => expect(harness.messages.some(message => message.type === 'cache-unavailable')).toBe(true));
  expect(dispose).toHaveBeenCalledOnce();
  expect(harness.messages.some(message => message.type === 'ready')).toBe(false);
  harness.send({ type: 'load' });
  await vi.waitFor(() => expect(harness.messages.some(message => message.type === 'ready')).toBe(true));
});

it('skips local model URLs on manual load and after a cache-only miss', async () => {
  const harness = await createHarness();
  mocks.pipeline.mockRejectedValueOnce(new Error('not cached'));
  harness.send({ type: 'load', cachedOnly: true });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'cache-unavailable')).toBe(true));
  expect(mocks.env.allowLocalModels).toBe(true);
  expect(mocks.env.allowRemoteModels).toBe(false);
  expect((await mocks.env.fetch('/models/missing.json')).status).toBe(404);
  harness.send({ type: 'load' });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'ready')).toBe(true));
  expect(mocks.env.allowLocalModels).toBe(false);
});

it('removes HTML cached as external weights but preserves valid weights and unrelated files', async () => {
  const prefix = 'https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX/resolve/main/';
  const bad = { url: prefix + 'onnx/model_q4f16.onnx_data' };
  const good = { url: prefix + 'onnx/model_q4f16.onnx' };
  const unrelated = { url: 'https://example.com/page.html' };
  const cache = {
    keys: async () => [bad, good, unrelated],
    match: async (request: { url: string }) => ({ headers: new Headers({ 'content-type': request === good ? 'application/octet-stream' : 'text/html' }) }),
    delete: vi.fn(),
  };
  vi.stubGlobal('caches', { keys: async () => ['transformers-cache'], open: async () => cache });
  const harness = await createHarness();
  harness.send({ type: 'load' });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'ready')).toBe(true));
  expect(cache.delete).toHaveBeenCalledExactlyOnceWith(bad);
  expect(mocks.env.allowLocalModels).toBe(false);
  expect(mocks.env.allowRemoteModels).toBe(true);
});

it('rejects an incomplete cache before starting model initialization and allows manual download', async () => {
  const harness = await createHarness();
  mocks.requireCache.mockRejectedValueOnce(new Error('Missing external weights'));
  harness.send({ type: 'load', cachedOnly: true });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'cache-unavailable')).toBe(true));
  expect(mocks.pipeline).not.toHaveBeenCalled();
  harness.send({ type: 'load' });
  await vi.waitFor(() => expect(harness.messages.some(m => m.type === 'ready')).toBe(true));
});

it('counts transferred bytes once per file, ignores cache callbacks, and separates initialization', async () => {
  mocks.env.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const size = String(input).endsWith('tokenizer_config.json') ? 7 : 5;
    return new Response(new Uint8Array(size));
  });
  mocks.inspectCache.mockResolvedValue({ availability: 'incomplete', missing: ['config.json', 'tokenizer_config.json'] });
  const harness = await createHarness();
  mocks.pipeline.mockImplementation(async (_task, _model, options) => {
    // These library callbacks also describe cache reads, and must not count as transfers.
    options.progress_callback({ status: 'progress', file: 'onnx/model_q4f16.onnx', loaded: 900_000_000 });
    const prefix = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
    for (const file of ['config.json', 'config.json', 'tokenizer_config.json']) {
      await (await mocks.env.fetch(prefix + file)).arrayBuffer();
      options.progress_callback({ status: 'done', file });
    }
    return harness.generator;
  });
  harness.send({ type: 'load', loadId: 42 });
  await vi.waitFor(() => expect(harness.messages.some(message => message.type === 'ready')).toBe(true));
  const progress = harness.messages.filter(message => message.type === 'progress');
  expect(progress.at(-1)).toMatchObject({ loadId: 42, progress: { stage: 'initializing', downloadedBytes: 12 } });
  expect(Math.max(...progress.map(message => message.progress!.downloadedBytes!))).toBe(12);
  expect(harness.messages.find(message => message.type === 'ready')).toMatchObject({ loadId: 42 });
});

it('reports zero downloaded bytes when every file comes from cache', async () => {
  const network = mocks.env.fetch;
  const harness = await createHarness();
  mocks.pipeline.mockImplementation(async (_task, _model, options) => {
    for (const file of REQUIRED_MODEL_FILES) {
      options.progress_callback({ status: 'progress', file, loaded: 100_000 });
      options.progress_callback({ status: 'done', file });
    }
    return harness.generator;
  });
  harness.send({ type: 'load', cachedOnly: true, loadId: 7 });
  await vi.waitFor(() => expect(harness.messages.some(message => message.type === 'ready')).toBe(true));
  expect(network).not.toHaveBeenCalled();
  expect(harness.messages.filter(message => message.type === 'progress').every(message =>
    message.loadId === 7 && message.progress?.downloadedBytes === 0 && message.progress.stage === 'initializing',
  )).toBe(true);
});

it.each(['missing', 'incomplete', 'corrupt'] as const)('reports structured cached-load failure: %s', async reason => {
  mocks.requireCache.mockRejectedValue(new ModelCacheError('Cache unavailable', reason));
  const harness = await createHarness();
  harness.send({ type: 'load', cachedOnly: true, loadId: 8 });
  await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
    type: 'cache-unavailable', loadId: 8, reason,
  })));
  expect(mocks.pipeline).not.toHaveBeenCalled();
});

it.each([
  [new Error('GPU initialization failed'), 'initialization'],
  [new DOMException('Storage full', 'QuotaExceededError'), 'storage'],
])('classifies initialization failures without implying corruption', async (error, reason) => {
  const harness = await createHarness();
  mocks.pipeline.mockRejectedValue(error);
  harness.send({ type: 'load', loadId: 9 });
  await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
    type: 'error', operation: 'load', loadId: 9, reason,
  })));
});

it('classifies required-file HTTP errors as network failures even with an empty body', async () => {
  mocks.env.fetch = vi.fn(async () => new Response(null, { status: 503 }));
  const harness = await createHarness();
  mocks.pipeline.mockImplementation(async () => {
    await mocks.env.fetch(`https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/config.json`);
    throw new Error('Could not fetch config');
  });
  harness.send({ type: 'load', loadId: 10 });
  await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
    type: 'error', operation: 'load', loadId: 10, reason: 'network',
  })));
});

it('cleans invalid JSON selectively and keeps valid metadata and weights on explicit download', async () => {
  const prefix = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
  const responses = new Map([
    [prefix + 'config.json', new Response('{invalid', { headers: { 'content-type': 'application/json' } })],
    [prefix + 'tokenizer.json', new Response('{}', { headers: { 'content-type': 'application/json' } })],
    [prefix + 'onnx/model_q4f16.onnx', new Response('valid weights')],
  ]);
  const cache = {
    keys: async () => [...responses.keys()].map(url => ({ url })),
    match: async (request: { url: string }) => responses.get(request.url)?.clone(),
    delete: vi.fn(),
  };
  vi.stubGlobal('caches', { keys: async () => ['model'], open: async () => cache });
  const harness = await createHarness();
  harness.send({ type: 'load', loadId: 11 });
  await vi.waitFor(() => expect(harness.messages.some(message => message.type === 'ready')).toBe(true));
  expect(cache.delete).toHaveBeenCalledExactlyOnceWith({ url: prefix + 'config.json' });
});


describe('worker query resolution', () => {
  it('rewrites a follow-up with deterministic decoding and the recent conversation', async () => {
    const harness = await createHarness({ final: 'Resolve the subject.</think>coffee blood pressure' });
    harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [{ role: 'user', content: 'coffee' }, { role: 'assistant', content: 'Earlier response' }] });
    expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'resolved-query', query: 'coffee blood pressure', contextLimited: false });
    const messages = harness.generator.mock.calls[0][0];
    if (typeof messages === 'string') throw new Error('The first query call must use conversation messages.');
    expect(messages.at(-1)!.content).toContain('coffee');
    expect(messages.at(-1)!.content).toContain('What about it?');
    expect(harness.generator.mock.calls[0][1]).toMatchObject({ max_new_tokens: 640, do_sample: false, tokenizer_encode_kwargs: { enable_thinking: true } });
  });
  it('reports invalid rewriting output as a retryable resolution failure', async () => {
    const harness = await createHarness({ final: '</think>First line\nSecond line' });
    harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [] });
    expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'error', requestId: 'resolve-1' });
  });
  it('caps the resolved query independently of its reasoning and returns only the final JSON query', async () => {
    const harness = await createHarness();
    harness.generator.mockImplementation(async (messages, options) => {
      const tokens = options.streamer!.options.token_callback_function!;
      const cap = options.stopping_criteria!.at(-1)!;
      tokens([9n, 1n, 2n, 3n]); tokens(new Array(127).fill(9n)); expect(cap._call([[99]])).toEqual([false]);
      tokens([9n]); expect(cap._call([[99]])).toEqual([true]);
      return generatedOutput(messages, 'Reason about coffee.</think>{"query":"coffee blood pressure"}');
    });
    harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [] });
    expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'resolved-query', query: 'coffee blood pressure' });
    expect(harness.messages.some(message => message.type === 'answer-delta' || message.type === 'thinking-delta')).toBe(false);
  });
  it('finalizes an exhausted query rewrite into deterministic bounded JSON without exposing reasoning', async () => {
    const harness = await createHarness();
    harness.generator.tokenizer.apply_chat_template.mockImplementation(messages => `${JSON.stringify(messages)}<think>`);
    harness.generator.mockImplementation(async (messages, options) => {
      if (typeof messages !== 'string') {
        exhaustThinking(options, 'Resolve coffee as the subject.', 512);
        return generatedOutput(messages, 'Resolve coffee as the subject.');
      }
      expect(messages).toContain('What about it?');
      expect(messages).toContain('coffee');
      expect(messages.endsWith('<think>Resolve coffee as the subject.\n</think>\n\n')).toBe(true);
      expect(options).toMatchObject({ max_new_tokens: 128, do_sample: false, return_full_text: false, add_special_tokens: false });
      expect(options.stopping_criteria).toHaveLength(1);
      return generatedOutput(messages, '{"query":"coffee blood pressure"}');
    });
    harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [{ role: 'user', content: 'coffee' }] });
    expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'resolved-query', query: 'coffee blood pressure' });
    expect(harness.generator).toHaveBeenCalledTimes(2);
    expect(harness.messages.some(message => ['thinking-delta', 'answer-delta'].includes(message.type))).toBe(false);
  });
  it.each(['{"query":""}', JSON.stringify({ query: 'x'.repeat(501) })])
    ('validates finalization query output instead of accepting malformed queries: %j', async final => {
      const harness = await createHarness();
      harness.generator.mockImplementation(async (messages, options) => {
        if (typeof messages !== 'string') {
          exhaustThinking(options, 'Resolve the subject.', 512);
          return generatedOutput(messages, 'Resolve the subject.');
        }
        return generatedOutput(messages, final);
      });
      harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [] });
      expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'error', operation: 'resolve-query', requestId: 'resolve-1' });
      expect(harness.generator).toHaveBeenCalledTimes(2);
      expect(harness.messages.some(message => message.type === 'resolved-query')).toBe(false);
    });
  it('cancels a queued rewrite before invoking the model', async () => {
    const harness = await createHarness();
    harness.send({ type: 'resolve-query', requestId: 'resolve-1', question: 'What about it?', history: [] });
    harness.send({ type: 'cancel', requestId: 'resolve-1' });
    expect(await harness.terminal('resolve-1')).toMatchObject({ type: 'cancelled' });
    expect(harness.generator).not.toHaveBeenCalled();
  });
});
