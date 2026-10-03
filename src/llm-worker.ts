import { requireCompleteModelCache } from './model-readiness.ts';
import {
  InterruptableStoppingCriteria,
  TextStreamer,
  pipeline,
  env,
} from '@huggingface/transformers';
import type { TextGenerationPipeline } from '@huggingface/transformers';
import {
  CHAT_TEMPLATE_OPTIONS,
  buildMessages,
  fitDocumentsToTokenBudget,
  streamedAnswer,
  stripThinking,
} from './rag.ts';
import { errorMessage } from './errors.ts';
import type { ModelProgress, WorkerRequest, WorkerResponse } from './types.ts';
import { MODEL_ID, MODEL_REVISION } from './model-cache.ts';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// This app hosts no model files under /models. Browser cache is still used.
env.allowLocalModels = false;
const modelFetch = env.fetch ?? globalThis.fetch;
let cacheOnlyFetch = false;
env.fetch = (...args) => cacheOnlyFetch
  ? Promise.resolve(new Response(null, { status: 404 }))
  : modelFetch(...args);

const MAX_INPUT_TOKENS = 3500;

let generator: TextGenerationPipeline | undefined;
let loading: Promise<TextGenerationPipeline> | undefined;
let activeGeneration: { requestId: string; stoppingCriteria: InterruptableStoppingCriteria; cancelled: boolean } | undefined;
let generationQueue: Promise<void> = Promise.resolve();
const cancelledRequestIds = new Set<string>();

function report(message: WorkerResponse) {
  workerScope.postMessage(message);
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
    loading = removeInvalidModelCache().then(async () => {
      if (cachedOnly) await requireCompleteModelCache();
    }).then(() => pipeline('text-generation', MODEL_ID, {
      device: 'webgpu',
      local_files_only: cachedOnly,
      dtype: 'q4f16',
      revision: MODEL_REVISION,
      progress_callback(progress) {
        report({ type: 'progress', progress: progress as ModelProgress });
      },
    })).then(value => {
      if (!value.tokenizer) throw new Error('The saved model is missing its tokenizer files.');
      generator = value;
      report({ type: 'ready', model: MODEL_ID, revision: MODEL_REVISION });
      return value;
    }).catch(error => {
      loading = undefined;
      report(cachedOnly
        ? { type: 'cache-unavailable', operation: 'load', message: errorMessage(error) }
        : { type: 'error', operation: 'load', message: errorMessage(error) });
      throw error;
    });
  }
  return loading;
}

async function countTokens(messages: ReturnType<typeof buildMessages>): Promise<number> {
  if (!generator) throw new Error('The local model is not loaded.');
  const prompt = generator.tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
    ...CHAT_TEMPLATE_OPTIONS,
  });
  return generator.tokenizer.encode(prompt).length;
}

function generatedText(output: unknown, streamed: string): string {
  const result = output as Array<{ generated_text?: string | Array<{ content?: string }> }>;
  const generated = result?.[0]?.generated_text;
  if (Array.isArray(generated)) return generated.at(-1)?.content ?? streamed;
  return typeof generated === 'string' ? generated : streamed;
}

async function generate({ requestId, question, documents }: Extract<WorkerRequest, { type: 'generate' }>) {
  if (cancelledRequestIds.delete(requestId)) {
    report({ type: 'cancelled', requestId });
    return;
  }
  const stoppingCriteria = new InterruptableStoppingCriteria();
  const state = { requestId, stoppingCriteria, cancelled: false };
  activeGeneration = state;

  try {
    const model = await loadModel();
    const fitted = await fitDocumentsToTokenBudget(
      question,
      documents,
      countTokens,
      MAX_INPUT_TOKENS,
    );
    if (state.cancelled) {
      report({ type: 'cancelled', requestId });
      return;
    }
    if (!fitted.length) throw new Error('The retrieved documents do not fit in the model context window.');

    report({ type: 'context',
      requestId,
      documentIds: fitted.map(document => document.id),
    });
    const messages = buildMessages(question, fitted);
    let streamed = '';
    let visibleLength = 0;
    const streamer = new TextStreamer(model.tokenizer, {
      skip_prompt: true,
      // MiniCPM's <think> tags are ordinary added tokens, so this preserves
      // reasoning boundaries while omitting EOS/chat control tokens.
      skip_special_tokens: true,
      callback_function(text) {
        if (state.cancelled) return;
        streamed += text;
        const visible = streamedAnswer(streamed);
        if (visible.length > visibleLength) {
          report({ type: 'answer-delta', requestId, text: visible.slice(visibleLength) });
          visibleLength = visible.length;
        }
      },
    });

    const output = await model(messages, {
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
      report({ type: 'cancelled', requestId });
      return;
    }
    const answer = stripThinking(generatedText(output, streamed));
    if (!answer.trim()) throw new Error('The model stopped before producing an answer. Please retry the search.');
    report({ type: 'complete',
      requestId,
      answer,
      documentIds: fitted.map(document => document.id),
    });
  } catch (error) {
    if (state.cancelled) report({ type: 'cancelled', requestId });
    else report({ type: 'error', operation: 'generate', requestId, message: errorMessage(error) });
  } finally {
    cancelledRequestIds.delete(requestId);
    if (activeGeneration === state) activeGeneration = undefined;
  }
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
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
