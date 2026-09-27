export const MODEL_ID = 'Mike0021/MiniCPM5-2B-ONNX';
export const MODEL_REVISION = '04a6c49fcba3a65a0351c92644c3a7e9d4343059';

// Files used by the pinned q4f16 text-generation pipeline in Transformers.js 4.2.
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_q4f16.onnx',
  ...Array.from({ length: 7 }, (_, index) =>
    `onnx/model_q4f16.onnx_data${index ? `_${index}` : ''}`),
];

export async function isModelCached(cacheStorage = globalThis.caches) {
  if (!cacheStorage) return false;
  try {
    const cache = await cacheStorage.open('transformers-cache');
    const base = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
    const entries = await Promise.all(MODEL_FILES.map(file => cache.match(`${base}${file}`)));
    return entries.every(Boolean);
  } catch {
    return false;
  }
}
