import {
  InterruptableStoppingCriteria,
  TextStreamer,
  pipeline,
  env,
} from '@huggingface/transformers';
import {
  CHAT_TEMPLATE_OPTIONS,
  buildMessages,
  fitDocumentsToTokenBudget,
  streamedAnswer,
  stripThinking,
} from './rag.js';

// This app hosts no model files under /models. Browser cache is still used.
env.allowLocalModels = false;
const modelFetch = env.fetch ?? globalThis.fetch;
let cacheOnlyFetch = false;
env.fetch = (...args) => cacheOnlyFetch
  ? Promise.resolve(new Response(null, { status: 404 }))
  : modelFetch(...args);

const MODEL_ID = 'Mike0021/MiniCPM5-2B-ONNX';
const MODEL_REVISION = '04a6c49fcba3a65a0351c92644c3a7e9d4343059';
const MAX_INPUT_TOKENS = 3500;

let generator;
let loading;
let activeGeneration;
let generationQueue = Promise.resolve();
const cancelledRequestIds = new Set();

function report(type, details = {}) {
  self.postMessage({ type, ...details });
}

// A previous local-path attempt may have cached SPA HTML as model JSON or external weights.
// Remove only those invalid entries; keep downloaded model weights intact.
async function removeInvalidModelCache() {
  if (!globalThis.caches) return;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (!request.url.includes(MODEL_ID)) continue;
      const response = await cache.match(request);
      if (response?.headers.get('content-type')?.includes('text/html')) await cache.delete(request);
    }
  }
}

async function loadModel(cachedOnly = false) {
  if (generator) return generator;
  if (!loading) {
    // Always skip SPA-local URLs. Disable remote model fetches for a cache-only
    // attempt while retaining browser-cache lookup in Transformers.js.
    cacheOnlyFetch = cachedOnly;
    env.allowLocalModels = cachedOnly;
    env.allowRemoteModels = !cachedOnly;
    loading = removeInvalidModelCache().then(() => pipeline('text-generation', MODEL_ID, {
      device: 'webgpu',
      local_files_only: cachedOnly,
      dtype: 'q4f16',
      revision: MODEL_REVISION,
      progress_callback(progress) {
        report('progress', { progress });
      },
    })).then(value => {
      generator = value;
      report('ready', { model: MODEL_ID, revision: MODEL_REVISION });
      return value;
    }).catch(error => {
      loading = undefined;
      report(cachedOnly ? 'cache-unavailable' : 'error', { operation: 'load', message: error.message });
      throw error;
    });
  }
  return loading;
}

async function countTokens(messages) {
  const prompt = generator.tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
    ...CHAT_TEMPLATE_OPTIONS,
  });
  return generator.tokenizer.encode(prompt).length;
}

function generatedText(output, streamed) {
  const generated = output?.[0]?.generated_text;
  if (Array.isArray(generated)) return generated.at(-1)?.content ?? streamed;
  return typeof generated === 'string' ? generated : streamed;
}

async function generate({ requestId, question, documents }) {
  if (cancelledRequestIds.delete(requestId)) {
    report('cancelled', { requestId });
    return;
  }
  const stoppingCriteria = new InterruptableStoppingCriteria();
  const state = { requestId, stoppingCriteria, cancelled: false };
  activeGeneration = state;

  try {
    await loadModel();
    const fitted = await fitDocumentsToTokenBudget(
      question,
      documents,
      countTokens,
      MAX_INPUT_TOKENS,
    );
    if (state.cancelled) {
      report('cancelled', { requestId });
      return;
    }
    if (!fitted.length) throw new Error('The retrieved documents do not fit in the model context window.');

    report('context', {
      requestId,
      documentIds: fitted.map(document => document.id),
    });
    const messages = buildMessages(question, fitted);
    let streamed = '';
    let visibleLength = 0;
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      // MiniCPM's <think> tags are ordinary added tokens, so this preserves
      // reasoning boundaries while omitting EOS/chat control tokens.
      skip_special_tokens: true,
      callback_function(text) {
        if (state.cancelled) return;
        streamed += text;
        const visible = streamedAnswer(streamed);
        if (visible.length > visibleLength) {
          report('answer-delta', { requestId, text: visible.slice(visibleLength) });
          visibleLength = visible.length;
        }
      },
    });

    const output = await generator(messages, {
      max_new_tokens: 512,
      do_sample: true,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 0,
      repetition_penalty: 1.0,
      streamer,
      stopping_criteria: [stoppingCriteria],
      tokenizer_encode_kwargs: CHAT_TEMPLATE_OPTIONS,
    });
    if (state.cancelled) {
      report('cancelled', { requestId });
      return;
    }
    const answer = stripThinking(generatedText(output, streamed));
    if (!answer.trim()) throw new Error('The model stopped before producing an answer. Please retry the search.');
    report('complete', {
      requestId,
      answer,
      documentIds: fitted.map(document => document.id),
    });
  } catch (error) {
    if (state.cancelled) report('cancelled', { requestId });
    else report('error', { operation: 'generate', requestId, message: error.message });
  } finally {
    cancelledRequestIds.delete(requestId);
    if (activeGeneration === state) activeGeneration = undefined;
  }
}

self.onmessage = event => {
  const message = event.data;
  if (message.type === 'load') {
    loadModel(message.cachedOnly === true).catch(() => {});
    return;
  }
  if (message.type === 'cancel') {
    cancelledRequestIds.add(message.requestId);
    if (activeGeneration?.requestId === message.requestId) {
      activeGeneration.cancelled = true;
      activeGeneration.stoppingCriteria.interrupt();
    }
    return;
  }
  if (message.type === 'generate') {
    if (activeGeneration) {
      activeGeneration.cancelled = true;
      activeGeneration.stoppingCriteria.interrupt();
    }
    generationQueue = generationQueue
      .catch(() => {})
      .then(() => generate(message));
  }
};
