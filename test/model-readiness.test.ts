import { expect, it, vi } from 'vitest';
import { inspectModelCache, requireCompleteModelCache, REQUIRED_MODEL_FILES } from '../src/model-readiness.ts';
import { MODEL_ID, MODEL_REMOTE_PATH_TEMPLATE, MODEL_REVISION } from '../src/model-cache.ts';
import { AutoTokenizer, env } from '@huggingface/transformers';
function storage(files: string[], revision = MODEL_REVISION) {
  return { keys: async () => ['model'], open: async () => ({
    keys: async () => files.map(file => ({ url: `https://huggingface.co/${MODEL_ID}/resolve/${revision}/${file}` })),
    match: async () => ({ headers: new Headers({ 'content-length': '1024' }) }),
  }) } as unknown as CacheStorage;
}
it('accepts the full pinned model cache without reading weight bodies', async () => {
  await expect(requireCompleteModelCache(storage(REQUIRED_MODEL_FILES))).resolves.toBeUndefined();
});
it('rejects a metadata-only cache and missing weight shards', async () => {
  await expect(requireCompleteModelCache(storage(REQUIRED_MODEL_FILES.slice(0, 4)))).rejects.toThrow('7 required files');
  await expect(requireCompleteModelCache(storage(REQUIRED_MODEL_FILES.slice(0, -1)))).rejects.toThrow('1 required files');
});
it('does not mistake another model revision for a complete cache', async () => {
  await expect(requireCompleteModelCache(storage(REQUIRED_MODEL_FILES, 'main'))).rejects.toThrow('incomplete');
});

function responseStorage(responses: Map<string, Response>) {
  const prefix = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
  return { keys: async () => ['model'], open: async () => ({
    keys: async () => [...responses.keys()].map(file => ({ url: prefix + file })),
    match: async (request: string | { url: string }) => responses.get((typeof request === 'string' ? request : request.url).slice(prefix.length))?.clone(),
  }) } as unknown as CacheStorage;
}

it('distinguishes missing, incomplete, and inaccessible model caches', async () => {
  await expect(inspectModelCache(responseStorage(new Map()))).resolves.toMatchObject({ availability: 'missing' });
  await expect(inspectModelCache(storage(['config.json']))).resolves.toMatchObject({ availability: 'incomplete' });
  await expect(inspectModelCache(undefined)).resolves.toMatchObject({ availability: 'unknown' });
  const inaccessible = { keys: async () => { throw new Error('Cache blocked'); } } as unknown as CacheStorage;
  await expect(inspectModelCache(inaccessible)).rejects.toThrow('Cache blocked');
});

it.each([
  ['config.json', new Response('{invalid', { headers: { 'content-type': 'application/json' } })],
  ['tokenizer_config.json', new Response('null', { headers: { 'content-type': 'application/json' } })],
  ['onnx/model_q4f16.onnx', new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } })],
])('classifies invalid cached data as corruption: %s', async (file, response) => {
  const cache = responseStorage(new Map([[file, response]]));
  await expect(inspectModelCache(cache)).resolves.toMatchObject({ availability: 'corrupt' });
  await expect(requireCompleteModelCache(cache)).rejects.toMatchObject({ reason: 'corrupt' });
});

it('accepts unknown-size files and validates metadata without consuming weight bodies', async () => {
  const readWeights = vi.fn(() => { throw new Error('Weight body read'); });
  const prefix = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
  const cache = { keys: async () => ['model'], open: async () => ({
    keys: async () => REQUIRED_MODEL_FILES.map(file => ({ url: prefix + file })),
    match: async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      return { headers: new Headers(), json: url.endsWith('.json') ? async () => ({}) : readWeights,
        text: readWeights, arrayBuffer: readWeights };
    },
  }) } as unknown as CacheStorage;
  await expect(inspectModelCache(cache)).resolves.toEqual({ availability: 'installed', missing: [] });
  expect(readWeights).not.toHaveBeenCalled();
});

it('loads a real tokenizer from a pinned cache without main-revision entries or network access', async () => {
  const prefix = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
  const files = new Map([
    [prefix + 'tokenizer_config.json', { tokenizer_class: 'PreTrainedTokenizer', unk_token: '[UNK]' }],
    [prefix + 'tokenizer.json', {
      version: '1.0', added_tokens: [], normalizer: null,
      pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
      model: { type: 'WordLevel', vocab: { '[UNK]': 0, hello: 1 }, unk_token: '[UNK]' },
    }],
  ]);
  const match = vi.fn(async (key: string) => {
    const file = files.get(key);
    return file ? new Response(JSON.stringify(file), { headers: { 'content-type': 'application/json' } }) : undefined;
  });
  const fetch = vi.fn(async () => { throw new Error('Network access is forbidden'); });
  const previous = {
    allowLocalModels: env.allowLocalModels, allowRemoteModels: env.allowRemoteModels,
    useCustomCache: env.useCustomCache, customCache: env.customCache,
    remotePathTemplate: env.remotePathTemplate, fetch: env.fetch,
  };
  Object.assign(env, {
    allowLocalModels: true, allowRemoteModels: false,
    useCustomCache: true, customCache: { match, put: vi.fn() },
    remotePathTemplate: MODEL_REMOTE_PATH_TEMPLATE, fetch,
  });
  try {
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true, revision: MODEL_REVISION });
    expect(tokenizer.encode('hello')).toEqual([1]);
    expect(match).toHaveBeenCalledWith(prefix + 'tokenizer_config.json');
    expect(match).toHaveBeenCalledWith(prefix + 'tokenizer.json');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    Object.assign(env, previous);
  }
});
