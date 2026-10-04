import { listModelCacheFiles, MODEL_REVISION } from './model-cache.ts';
import type { ModelCacheAvailability, ModelFailureReason } from './types.ts';

// This pinned q4f16 model declares seven external weight files in config.json.
export const REQUIRED_MODEL_FILES = [
  'config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4f16.onnx',
  ...Array.from({ length: 7 }, (_, i) => `onnx/model_q4f16.onnx_data${i ? `_${i}` : ''}`),
];

export class ModelCacheError extends Error {
  constructor(message: string, readonly reason: ModelFailureReason) { super(message); }
}

export async function inspectModelCache(storage: CacheStorage | undefined = globalThis.caches): Promise<{
  availability: ModelCacheAvailability; missing: string[];
}> {
  if (!storage) return { availability: 'unknown', missing: [...REQUIRED_MODEL_FILES] };
  const files = await listModelCacheFiles(storage);
  const saved = new Set(files.filter(file => file.size !== 0).map(file => file.path));
  const missing = REQUIRED_MODEL_FILES.filter(file => !saved.has(`resolve/${MODEL_REVISION}/${file}`));
  // Validate small metadata bodies; never read weight bodies for a health check.
  for (const file of files.filter(file => file.path.startsWith(`resolve/${MODEL_REVISION}/`))) {
    const response = await (await storage.open(file.cache)).match(file.url);
    if (response?.headers.get('content-type')?.includes('text/html')) return { availability: 'corrupt', missing };
    if (file.path.endsWith('.json') && response && typeof response.json === 'function') {
      try {
        const value = await response.json();
        if (!value || typeof value !== 'object') return { availability: 'corrupt', missing };
      } catch { return { availability: 'corrupt', missing }; }
    }
  }
  return { availability: missing.length ? (files.length ? 'incomplete' : 'missing') : 'installed', missing };
}

export async function requireCompleteModelCache(storage: CacheStorage | undefined = globalThis.caches) {
  const { availability, missing } = await inspectModelCache(storage);
  if (availability === 'installed') return;
  if (availability === 'corrupt') throw new ModelCacheError('Saved model metadata is invalid.', 'corrupt');
  if (availability === 'unknown') throw new ModelCacheError('No browser model cache is available.', 'cache');
  throw new ModelCacheError(`Model download is incomplete: ${missing.length} required files are missing.`, availability === 'missing' ? 'missing' : 'incomplete');
}
