import { expect, it, vi } from 'vitest';
import { requireCompleteModelCache, REQUIRED_MODEL_FILES } from '../src/model-readiness.ts';
import { MODEL_ID, MODEL_REVISION } from '../src/model-cache.ts';
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
