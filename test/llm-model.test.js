import { describe, expect, it, vi } from 'vitest';
import { isModelCached, MODEL_ID, MODEL_REVISION } from '../src/llm-model.js';

describe('local model cache detection', () => {
  it('requires every file from the pinned model revision', async () => {
    const missing = new Set();
    const match = vi.fn(async url => missing.has(url) ? undefined : {});
    const cacheStorage = { open: vi.fn(async () => ({ match })) };
    const base = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;

    expect(await isModelCached(cacheStorage)).toBe(true);
    expect(cacheStorage.open).toHaveBeenCalledWith('transformers-cache');
    expect(match).toHaveBeenCalledWith(`${base}tokenizer.json`);
    expect(match).toHaveBeenCalledWith(`${base}onnx/model_q4f16.onnx_data_6`);

    missing.add(`${base}onnx/model_q4f16.onnx_data_6`);
    expect(await isModelCached(cacheStorage)).toBe(false);
  });

  it('does not auto-load when browser cache access fails', async () => {
    expect(await isModelCached(null)).toBe(false);
    expect(await isModelCached({ open: async () => { throw new Error('blocked'); } })).toBe(false);
  });
});
