# RAGbox: Troubleshooting

Use the collection and model status messages in Chat or Settings to identify the failing stage. A ready collection is enough for keyword search; generated answers also require a ready model.

## Installation and startup

| Symptom | Check and recovery |
| --- | --- |
| `npm ci` or the build reports an unsupported Node version | Use the range in [package.json](../package.json): `^22.12.0` or `>=24.0.0`. Reinstall with `npm ci`. |
| The development server reports port `5173` is in use | Stop the conflicting process or existing server. `npm run dev` intentionally uses a strict port. |
| OPFS is unavailable | Use a supported browser on HTTPS or a loopback URL. Open the served application, not `index.html` as a file. Browser privacy settings can also restrict storage. |
| Startup says RAGbox is already open in another tab or window | Continue in the other tab, or close it and reload this page. RAGbox uses an origin-scoped Web Lock to allow one database owner at a time; the browser releases the lock when the tab closes or crashes. |
| Startup reports the local database is already in use, or conversation storage asks you to close other tabs | Close other RAGbox tabs on the same origin and reload. DuckDB OPFS handles are exclusive. Older tabs and browsers without Web Locks are detected through the database lock error, so the message says another tab may be using it. |
| The page loads but DuckDB initialization or FTS loading fails | Inspect failed network requests for the DuckDB worker, Wasm module, or matching FTS extension. Check network restrictions and the host's content/security policy. |
| Assets or workers fail under a hosted subpath | Build with the matching Vite `--base`. The current Pages command explicitly uses `/ragbox/`; see [deployment](deployment.md). |

## Collection setup and retrieval

| Symptom | Check and recovery |
| --- | --- |
| NFCorpus says the dataset is missing | Run `npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl` and confirm `public/data/nfcorpus.jsonl` exists. For a deployed site, prepare it before rebuilding so it reaches `dist/data/`. |
| Preparation rejects the corpus | Use the BEIR NFCorpus `corpus.jsonl` with exactly 3,633 unique `_id` values and string title/text fields. The preparation script expects BEIR input, rather than its own converted output. |
| NFCorpus offers **Retry setup** | Retry after resolving the displayed error. Check data availability and FTS requests. If a saved table is incompatible, inspect its owned database in Settings before deleting it. |
| MS MARCO reports insufficient storage | Make more browser quota available before retrying. The artifact alone is about 3.35 GB; the optional model needs additional space. Use Settings to inspect current files. |
| MS MARCO says the URL returned a web page or reports an incomplete/oversized download | Use a direct database URL with the exact expected byte count. Check redirects and CORS. A landing-page URL is not a database download. See [artifact hosting](collections.md#host-a-compatible-artifact). |
| MS MARCO downloaded but failed to open | Close other tabs and use the offered open/retry action before downloading again. Opening validates the saved table and FTS macro; a bad or incompatible file may require replacement. |
| A cancelled MS MARCO download restarts from zero | Partial transfers do not resume across reloads. An older committed index survives a cancelled replacement and can be reopened. |
| A query returns no sources | Check the selected collection and readiness, then try relevant keywords. Analyzer normalization removes stopwords; an all-stopword query can return no documents. |
| A follow-up searches the literal words | Confirm the model is ready. Without it, messages perform keyword search and contextual references are not rewritten. |
| A follow-up shows a resolution error | Retry or restate it as a standalone query. The application rejects invalid model rewrites rather than guessing; the browser console shows the model's raw output as a warning. |

Setup does not provide an arbitrary document-upload interface. For the supported schemas and native MS MARCO build script, see [collections and retrieval](collections.md).

## Model and GPU problems

| Symptom | Check and recovery |
| --- | --- |
| The model is unavailable on this device | Check WebGPU support and the adapter's `shader-f16` feature. Desktop Chrome on a supported GPU is the tested target. Keyword search remains usable. |
| Model transfer shows bytes but no percentage | This is expected: the application has no reliable whole-model denominator from the per-file progress events. GPU initialization is a subsequent stage. |
| A previously installed model needs files again | Return to the same origin and browser profile. Cache eviction or an interrupted transfer may leave files missing; use **Download missing files** when offered. |
| Cached files exist but initialization fails | Use **Retry loading**. If metadata is invalid, explicit repair can replace it while keeping valid weights. Check the detailed status and model file listing in Settings. |
| Cancelling still leaves model files in Settings | Completed cache entries are retained. Unfinished files may need another download. Use **Delete model** if you intend to remove the saved model. |
| Replies take a long time | Replies already skip reasoning. MS MARCO retrieval can take longer than NFCorpus. Device-specific timings in the validation notes are not guarantees. |
| Reasoning appears but no final answer is produced | An empty final answer remains retryable; reasoning is not used as an answer. Stop or retry the turn and inspect the current model status. |
| A reply has a valid citation but an unsupported claim | Read that turn's source snapshot. Citation membership does not verify the claim's meaning. Rephrase the question or inspect retrieval directly; see [recorded quality limitations](chat-validation.md#thinking-mode-actual-model-observations). |

See [the model guide](local-model.md) for revision pins, required files, reasoning limits, and recovery behavior.

## Persistence and Settings

| Symptom | Check and recovery |
| --- | --- |
| Indexes or chats appear missing after changing the URL | Check scheme, host, port, and browser profile. Development, preview, and published origins have separate storage. |
| History is absent from navigation | This is intentional in the default build: `HISTORY_ENABLED` is `false`. Conversations still persist for reloads and follow-ups. |
| A chat reopens as **Stopped** | Reload interrupted the turn. Use Retry to continue; the application does not restart inference automatically. |
| The unsaved-conversation notice appears | The current chat remains in page memory. Check IndexedDB availability, storage restrictions, and quota before relying on a reload to restore it. |
| Delete controls are disabled | Wait for active downloads, preparation, loading, or inference to finish, or cancel the active work. Deletion also waits for initialization and storage refreshes. |
| A deletion fails and **Reload to recover** appears | Close other RAGbox tabs, reload, and retry the intended operation. |
| **Delete indexes and model** leaves conversations | That control keeps conversations and source snapshots by design. **Clear history** removes them when the History feature is enabled. |

Use the [storage guide](storage.md#remove-saved-data) to choose the smallest applicable deletion. Browser-level clearing of all site data is broader and can remove chats and preferences as well as resource files.

## Report a reproducible problem

Include the browser and version, operating system, GPU when relevant, application origin/base path, selected collection, exact status/error text, and the steps that trigger it. Note whether the index/model was newly downloaded or restored from storage. For network failures, include the failing asset URL and HTTP status. For answer-quality issues, include the question, resolved query, final answer, and relevant source IDs/text.

For development failures, include the result of the relevant checks in [the development guide](development.md#validation). A bundle build or mocked test does not establish live browser inference behavior.

[Documentation](README.md)
