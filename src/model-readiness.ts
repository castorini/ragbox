import { listModelCacheFiles, MODEL_REVISION } from './model-cache.ts';

// This pinned q4f16 model declares seven external weight files in config.json.
export const REQUIRED_MODEL_FILES = [
  'config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4f16.onnx',
  ...Array.from({ length: 7 }, (_, i) => `onnx/model_q4f16.onnx_data${i ? `_${i}` : ''}`),
];

export async function requireCompleteModelCache(storage: CacheStorage | undefined = globalThis.caches) {
  if (!storage) throw new Error('No browser model cache is available.');
  const files = await listModelCacheFiles(storage);
  const saved = new Set(files.filter(file => file.size !== 0).map(file => file.path));
  const missing = REQUIRED_MODEL_FILES.filter(file => !saved.has(`resolve/${MODEL_REVISION}/${file}`));
  if (missing.length) throw new Error(`Model download is incomplete: ${missing.length} required files are missing. Use Load local LLM to download them.`);
}
