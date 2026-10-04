import { inspectModelCache, requireCompleteModelCache, REQUIRED_MODEL_FILES } from './model-readiness.ts';
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
import type { ModelFailureReason, ModelProgress, WorkerRequest, WorkerResponse } from './types.ts';
import { modelCachePath, MODEL_ID, MODEL_REMOTE_PATH_TEMPLATE, MODEL_REVISION } from './model-cache.ts';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// This app hosts no model files under /models. Browser cache is still used.
env.allowLocalModels = false;
// Transformers.js 4.2 tokenizer discovery omits revision and defaults to `main`.
// Pin the shared URL template so discovery finds the same cache as model loading.
env.remotePathTemplate = MODEL_REMOTE_PATH_TEMPLATE;
const modelFetch = env.fetch ?? globalThis.fetch;
let cacheOnlyFetch = false;
interface LoadTransfer {
  id: number;
  bytes: Map<string, number>;
  completed: Set<string>;
  stage: 'downloading' | 'initializing';
  lastUpdate: number;
  failure?: ModelFailureReason;
}
let transfer: LoadTransfer | undefined;

function transferProgress(current: LoadTransfer, force = false) {
  if (current !== transfer) return;
  const now = performance.now();
  if (!force && now - current.lastUpdate < 200) return;
  current.lastUpdate = now;
  report({ type: 'progress', loadId: current.id, progress: {
    stage: current.stage, downloadedBytes: [...current.bytes.values()].reduce((sum, bytes) => sum + bytes, 0),
  } });
}

env.fetch = async (...args) => {
  if (cacheOnlyFetch) return new Response(null, { status: 404 });
  const current = transfer;
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  const path = modelCachePath(url);
  let response: Response;
  try { response = await modelFetch(...args); }
  catch (error) {
    if (current && path) current.failure = 'network';
    throw error;
  }
  if (!current || !path) return response;
  if (!response.ok) {
    if (REQUIRED_MODEL_FILES.some(file => path === `resolve/${MODEL_REVISION}/${file}`)) current.failure = 'network';
    return response;
  }
  if (!response.body) return response;
  current.stage = 'downloading';
  let received = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      current.bytes.set(path, Math.max(current.bytes.get(path) ?? 0, received));
      transferProgress(current);
      controller.enqueue(chunk);
    },
    flush() { transferProgress(current, true); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

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
      if (modelCachePath(request.url) === null) continue;
      const response = await cache.match(request);
      let invalid = response?.headers.get('content-type')?.includes('text/html') ?? false;
      if (!invalid && request.url.endsWith('.json') && response && typeof response.json === 'function') {
        try {
          const value = await response.json();
          invalid = !value || typeof value !== 'object';
        } catch { invalid = true; }
      }
      if (invalid) await cache.delete(request);
    }
  }
}

async function loadModel(cachedOnly = false, loadId = 0) {
  if (generator) return generator;
  if (!loading) {
    // Always skip SPA-local URLs. Disable remote model fetches for a cache-only
    // attempt while retaining browser-cache lookup in Transformers.js.
    cacheOnlyFetch = cachedOnly;
    env.allowLocalModels = cachedOnly;
    env.allowRemoteModels = !cachedOnly;
    const current: LoadTransfer = { id: loadId, bytes: new Map(), completed: new Set(), stage: cachedOnly ? 'initializing' : 'downloading', lastUpdate: 0 };
    transfer = current;
    loading = (async () => {
      // Explicit repair/download attempts remove only entries proven invalid.
      if (!cachedOnly) await removeInvalidModelCache();
      let cache;
      try { cache = await inspectModelCache(); }
      catch (error) { current.failure = 'cache'; throw error; }
      for (const file of REQUIRED_MODEL_FILES) if (!cache.missing.includes(file)) current.completed.add(file);
      current.stage = cache.availability === 'installed' ? 'initializing' : current.stage;
      report({ type: 'cache-status', loadId, availability: cache.availability });
      if (cachedOnly) await requireCompleteModelCache();
      transferProgress(current, true);
      return pipeline('text-generation', MODEL_ID, {
        device: 'webgpu', local_files_only: cachedOnly, dtype: 'q4f16', revision: MODEL_REVISION,
        progress_callback(progress) {
          const event = progress as ModelProgress;
          if (event.status === 'done' && event.file) {
            current.completed.add(event.file);
            if (REQUIRED_MODEL_FILES.every(file => current.completed.has(file))) {
              current.stage = 'initializing';
              transferProgress(current, true);
            }
          }
        },
      });
    })().then(async value => {
      if (!value.tokenizer) {
        await value.dispose();
        throw new Error('The saved model is missing its tokenizer files.');
      }
      generator = value;
      report({ type: 'ready', loadId, model: MODEL_ID, revision: MODEL_REVISION });
      return value;
    }).catch(error => {
      loading = undefined;
      const reason = error && typeof error === 'object' && 'reason' in error
        ? error.reason as ModelFailureReason
        : error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'storage' : current.failure ?? 'initialization';
      report(cachedOnly
        ? { type: 'cache-unavailable', operation: 'load', loadId, reason, message: errorMessage(error) }
        : { type: 'error', operation: 'load', loadId, reason, message: errorMessage(error) });
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
    if (!answer.trim()) throw new Error('The model stopped before producing an answer. Retry answer.');
    report({ type: 'complete',
      requestId,
      answer,
      documentIds: fitted.map(document => document.id),
    });
  } catch (error) {
    if (state.cancelled) report({ type: 'cancelled', requestId });
    else report({ type: 'error', operation: 'generate', reason: 'generation', requestId, message: errorMessage(error) });
  } finally {
    cancelledRequestIds.delete(requestId);
    if (activeGeneration === state) activeGeneration = undefined;
  }
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    loadModel(message.cachedOnly === true, message.loadId ?? 0).catch(() => {});
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
