# RAGbox: Local Answer Model

The optional answer model runs on the device in a Web Worker. DuckDB still performs retrieval; the model rewrites contextual follow-ups and generates answers from the current retrieved evidence.

## Model and device requirements

| Setting | Current value |
| --- | --- |
| Model | [Mike0021/MiniCPM5-2B-ONNX](https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX) |
| Pinned revision | `04a6c49fcba3a65a0351c92644c3a7e9d4343059` |
| Runtime | Transformers.js `4.2.0` in a Web Worker |
| Execution | WebGPU with `q4f16` weights |
| GPU feature | `shader-f16` |
| Approximate transfer | 1.84 GB |

Desktop Chrome on a supported GPU is the tested target. Capability checks require a WebGPU adapter exposing `shader-f16`; the current application has no CPU inference fallback. Keyword search remains available when the GPU is unsupported.

The model ID and revision live in [src/model-cache.ts](../src/model-cache.ts). Loading and tokenizer discovery share the same pinned revision. The model and its base model are Apache-2.0 licensed; review the model card before redistributing weights.

## Download and load

Click **Download model (~1.84 GB)** on the start page or in Settings. Downloads require an explicit action. Progress reports cumulative transferred bytes with an indeterminate bar because individual file events do not provide a reliable whole-model total. GPU initialization follows the transfer and can take additional time.

Once required files are cached, later visits automatically load them on supported devices using `local_files_only`. Missing model files do not trigger an automatic download. The application stores weights in browser Cache Storage, separately from the collection databases in OPFS.

**Cancel download** or **Cancel loading** stops that operation and invalidates queued initialization. Completed cached files remain available; unfinished files may need to download again. See [browser storage](storage.md) for cache inspection and deletion.

## Thinking effort

Use the lightbulb button in the composer to select a level. The choice is saved in this browser and captured when a message is submitted.

| Level | Answer reasoning allowance | Final answer allowance | Follow-up rewrite allowance |
| --- | --- | --- | --- |
| Off, the default | Thinking template disabled | Up to 512 tokens | No reasoning; up to 128 query tokens |
| Low | Up to 256 reasoning tokens | Up to 512 tokens | Up to 512 reasoning tokens plus 128 query tokens |
| Medium | Up to 1,024 reasoning tokens | Up to 512 tokens | Up to 512 reasoning tokens plus 128 query tokens |

These are application token budgets, not a native model effort parameter. The Medium value is stored internally as `balanced`; an obsolete High preference falls back to Off. See [src/thinking-effort.ts](../src/thinking-effort.ts) and [src/llm-worker.ts](../src/llm-worker.ts).

Reasoning and final-output limits are separate. If reasoning reaches its limit before a final answer or valid query appears, the worker closes the same assistant's reasoning prefix and requests a bounded final output. Empty answers and invalid resolved queries still expose Retry. Reasoning is never substituted for the answer or the search query.

Low and Medium display reasoning in a folded **Reasoning** section. Reasoning does not contribute citations or later conversation context. Changing the preference during a turn does not change that turn or its retries.

More reasoning increases latency and does not guarantee better answers. [Chat validation](chat-validation.md#thinking-mode-browser-smoke-test) records single-device timing observations and remaining quality issues; those observations are not a general performance or quality benchmark.

## Context and output limits

Both query rewriting and answer generation receive up to three recent turns. The worker limits their questions and completed final replies to 750 tokens, dropping the oldest whole exchanges. Reasoning is excluded. A context notice reports omitted history while the saved transcript remains complete.

Answer generation fits instructions, the current question, history, and retrieved evidence into a **3,500-token initial input budget**. Documents are considered in retrieval order. The fitter may truncate the last included document and omit later ones. A finalization request also includes the reasoning produced during that turn, so its input can exceed the initial budget.

The first message searches directly; contextual follow-ups use deterministic query rewriting with a 128-token output limit and a validated query of at most 500 characters. Answer generation uses sampling, so repeated questions can produce different wording and claims.

Answer instructions request one to three sentences with citations from fitted documents. They ask the model to distinguish measured results from background statements, preserve uncertainty, and use previous answers only to interpret references. These prompts do not establish correctness: inspect the saved sources for each claim. See [chatting with documents](usage-chat.md#read-sources-and-citations).

## Recover a model installation

Use the action offered by the interface:

| Action | Purpose |
| --- | --- |
| **Download model** | Install files when no complete cache is available. |
| **Download missing files** | Repair an incomplete installation after interruption or eviction. |
| **Retry loading** | Retry initialization when cached files are available. |
| **Cancel download** / **Cancel loading** | Stop the current resource operation. |

Cache readiness requires the pinned configuration and tokenizer files, the quantized ONNX model, and seven external weight files. The readiness check validates small metadata responses without reading multi-gigabyte weight bodies. Explicit repair can discard invalid cached configuration while retaining valid weights.

If recovery fails, inspect the model file listing under Settings → **Advanced file management** and use [troubleshooting](troubleshooting.md#model-and-gpu-problems). Deleting the model is available separately from deleting indexes.

Cached inference does not make the application fully offline. Application startup and DuckDB runtime/extension loading may still require network access. There is no inference server, API key, or document upload in the answer-generation path.

[Documentation](README.md)
