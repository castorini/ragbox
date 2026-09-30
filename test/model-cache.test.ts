import { expect, it, vi } from 'vitest';
import { deleteModelCacheFiles, listModelCacheFiles, modelCachePath, MODEL_ID } from '../src/model-cache.ts';

const prefix = `https://huggingface.co/${MODEL_ID}/resolve/revision/`;

function cacheStorage(entries: Record<string, Record<string, string | null>>) {
  const caches = new Map(Object.entries(entries).map(([name, files]) => [name, {
    keys: vi.fn(async () => Object.keys(files).map(url => new Request(url))),
    match: vi.fn(async (request: Request) => request.url in files ? Object.assign(new Response(null, {
      headers: new Headers(files[request.url] === null ? {} : { 'content-length': files[request.url]! }),
    }), {
      arrayBuffer: () => { throw new Error('Must not read model weights into memory'); },
    }) : undefined),
    delete: vi.fn(async (request: Request) => { delete files[request.url]; return true; }),
  }]));
  return {
    keys: vi.fn(async () => [...caches.keys()]),
    open: vi.fn(async (name: string) => caches.get(name)!),
    delete: vi.fn(),
  } as unknown as CacheStorage;
}

it('matches exact model paths, including encoded and old local paths', () => {
  expect(modelCachePath(`${prefix}onnx/model.onnx`)).toBe('resolve/revision/onnx/model.onnx');
  expect(modelCachePath(`https://example.com/models/${MODEL_ID}/config.json`)).toBe('config.json');
  expect(modelCachePath(`https://example.com/${encodeURIComponent(MODEL_ID)}/config.json`)).toBe('config.json');
  for (const url of ['invalid', `https://example.com/${MODEL_ID}-other/config.json`,
    `https://example.com/other/${MODEL_ID}/config.json`, `https://example.com/file?model=${MODEL_ID}`]) {
    expect(modelCachePath(url)).toBeNull();
  }
});

it('lists model entries across caches and uses size headers without reading bodies', async () => {
  const storage = cacheStorage({
    transformers: { [`${prefix}onnx/model.onnx`]: '1840000000', 'https://example.com/other.bin': '12' },
    legacy: { [`https://example.com/models/${MODEL_ID}/config.json`]: null, [`${prefix}tokenizer.json`]: 'invalid' },
  });
  const files = await listModelCacheFiles(storage);
  expect(files).toHaveLength(3);
  expect(files.find(file => file.path.endsWith('model.onnx'))?.size).toBe(1840000000);
  expect(files.find(file => file.path.endsWith('config.json'))?.size).toBeNull();
  expect(files.find(file => file.path.endsWith('tokenizer.json'))?.size).toBeNull();
});

it('deletes model entries only and keeps shared caches and other models', async () => {
  const other = 'https://huggingface.co/other/model/resolve/main/model.onnx';
  const storage = cacheStorage({ transformers: { [`${prefix}model.onnx`]: '1', [other]: '2' } });
  await deleteModelCacheFiles(storage);
  const cache = await storage.open('transformers');
  expect((await cache.keys()).map(request => request.url)).toEqual([other]);
  expect(storage.delete).not.toHaveBeenCalled();
});

it('reports entries that cannot be deleted', async () => {
  const storage = cacheStorage({ transformers: { [`${prefix}model.onnx`]: '1' } });
  const cache = await storage.open('transformers');
  vi.mocked(cache.delete).mockResolvedValue(false);
  await expect(deleteModelCacheFiles(storage)).rejects.toThrow('Could not delete model cache entry');
});
