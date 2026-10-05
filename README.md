# RAGbox

A document chatbot that runs locally in your browser. DuckDB-Wasm retrieves the top ten BM25 matches from NFCorpus or MS MARCO, and an optional MiniCPM model writes a streamed answer with citations. Follow-up questions search fresh evidence. No inference server, API key, or document upload is used.

## Getting started

Requirements: Node.js 22.12+ or 24+, npm, and a modern browser with OPFS support. Local inference also requires WebGPU with `shader-f16`; desktop Chrome on a supported GPU is the tested target. Internet access is needed to load DuckDB runtime/extension assets and to download collections or model files.

```sh
npm ci
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
npm run dev
```

Open **http://127.0.0.1:5173/**. The preparation script validates BEIR NFCorpus IDs and copies title/text fields into `public/data/nfcorpus.jsonl`; it does not build an index. Generated datasets are excluded from Git. The published demo includes this dataset through its Pages workflow. See the [NFCorpus guide](https://github.com/castorini/quackir/blob/main/docs/experiments-nfcorpus.md) for the source dataset.

Use the same exact address and browser profile on return visits. `localhost:5173` and `127.0.0.1:5173` have separate storage. Keep one RAGbox tab open per origin because DuckDB OPFS handles are exclusive.

## Chatting with documents

Choose a **Document collection** and prepare or open its index. Ask a question in the bottom composer; **Enter** sends, **Shift+Enter** adds a newline, and messages are limited to 500 characters. The draft remains editable during processing. **Stop** retains partial text and valid citation links.

Each reply has expandable **Sources** containing the retrieved document snapshot, BM25 scores, resolved search query, and full text. Clicking a citation opens its sources and focuses the cited document. Links are created only for IDs in the current fitted evidence. Unknown IDs remain plain text. Output is rendered as text, not model-supplied HTML.

**New chat** and the RAGbox logo start an empty chat in the selected collection. Switching collections stops current work and restores the selected collection's chat. **Settings** and **History** preserve ongoing work. History searches conversation titles, questions, answers, and source titles; **Continue chat** selects the saved chat's collection.

The first message searches directly. Later messages are rewritten by the local model into a standalone query before searching. A rewrite failure shows **Retry** rather than guessing. Generation retries reuse the turn's question, captured history, and retrieved sources; failed rewrite or retrieval stages run again. Retry updates the latest turn without duplicating it.

Without a ready model, messages perform literal **keyword search**. Sources remain usable, and the UI explains that contextual follow-ups require the model. Loading the model finishes only the latest unanswered active turn, resolving and searching again when conversational context is needed. Downloads always require an explicit action.

Scrolling follows new text while you are near the bottom. Scrolling back preserves your position, and streaming never changes keyboard focus.

## Collections

**NFCorpus** contains 3,633 nutrition and medical articles. Click **Prepare NFCorpus** in Chat or **Set up collection** in Settings to import the JSONL data, load `fts`, build a BM25 index over title and text, and checkpoint the database. Saved indexes reopen at startup. Older tables containing only `id` and `contents` remain searchable.

**MS MARCO** uses a prebuilt index of about 3.35 GB. Click **Download MS MARCO index (3.35 GB)** and confirm. Progress shows downloaded bytes followed by index opening. A downloaded index opens when that collection is selected; **Open downloaded collection** is available for recovery. Downloads can be cancelled but do not resume across reloads. Cancelling a replacement preserves the older saved index.

Both collections return up to ten matches, ordered by descending BM25 score and document ID to break ties. Queries use bound parameters. Retrieval runs in DuckDB-Wasm on the device. FTS indexes do not automatically track subsequent table edits. Empty retrieval produces an insufficient-evidence reply without invoking answer generation.

The index files live in the browser's Origin Private File System, not the Downloads folder. Native index construction and earlier scaling measurements are documented in [the experiment notes](docs/experiments.md). The original persistence experiments were based on [DuckDB's OPFS article](https://duckdb.org/2026/09/18/opfs-wasm).

## Local model and context

Click **Download model (~1.84 GB)** in Chat or Settings to install the quantized [MiniCPM5-2B ONNX model](https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX). A Web Worker uses Transformers.js, WebGPU, `q4f16` weights, and the model's direct-answer template with thinking disabled. The pinned model revision is shared by loading and tokenizer discovery.

Follow-up rewriting uses deterministic decoding with a 128-token output limit. Answers retain the 512-token output limit. Both operations receive up to three recent turns; user questions and completed assistant replies are limited to 750 tokens by dropping the oldest exchanges. Instructions, the current message, history, and fitted documents share the 3,500-token answer input budget. A notice appears when earlier context is omitted; the saved transcript remains complete.

Previous answers help resolve references but are not factual evidence. Answer instructions require citations from the current fitted documents and preserve uncertainty. These constraints do not guarantee model accuracy: inspect cited sources, especially for research questions. The browser quality checks and remaining model limitations are described in [chat validation](docs/chat-validation.md).

Cached model files load automatically on supported devices using `local_files_only`; missing files never trigger an automatic download. Recovery offers **Download model**, **Download missing files**, or **Retry loading** according to the failure. Explicit repair can remove invalid cached configuration entries while retaining valid weights. **Cancel download** and **Cancel loading** also invalidate queued initialization. Completed cached files remain available; unfinished files may download again.

Transfer shows cumulative downloaded bytes with an indeterminate bar because individual file progress does not provide a reliable whole-model denominator. GPU initialization follows transfer. Model files may be evicted by the browser. The model and its base model are Apache-2.0 licensed; review the model card before redistributing weights.

## Saved conversations and storage

Conversations use a versioned, asynchronous IndexedDB repository. Submitted turns, retrieval snapshots, settled answers, and citation metadata are saved. Streaming text is checkpointed at most once per second. Writes are serialized so a slow earlier save cannot overwrite a later answer. The newest 50 nonempty conversations are retained, titled from their first question.

Existing localStorage search history imports as individual one-turn conversations with deterministic IDs. Timestamps, sources, answers, and stopped status are preserved. The import marker commits with the imported conversations to prevent duplicates; original legacy data is retained until **Clear history**.

Reload restores the selected collection and its chat. Interrupted turns become **Stopped** and require explicit Retry; inference never restarts from a saved transcript automatically. If storage fails, the current chat stays usable in memory and an unsaved notice appears. Browser storage can be cleared or evicted, so saved chats are not an independent backup.

**Clear history** requires confirmation, stops active work, clears conversations and legacy search history, and opens an empty chat. Index or model deletion keeps conversations and source snapshots readable. New retrieval requires a prepared collection.

Settings groups index and model management separately. **Advanced file management** exposes file listings, refresh actions, and MS MARCO replacement. Deep links to Settings sections remain supported. **Delete index data**, **Delete model**, and **Delete indexes and model** close the appropriate runtimes, delete only RAGbox-owned files, and reload after confirmation. Deletion is disabled during active resource work. **Reload to recover** appears if shutdown or deletion fails.

## Implementation

```text
src/main.ts                  Startup, collection adapters, and resource gates
src/collection-retrieval.ts  DOM-independent normalized BM25 retrieval
src/nfcorpus.ts               NFCorpus preparation and Settings adapter
src/msmarco.ts                Saved MS MARCO index lifecycle and Settings adapter
src/model-service.ts          DOM-independent model lifecycle and cancellable operations
src/llm-controller.ts         Existing model controls and safe answer rendering
src/llm-worker.ts             Query resolution, context fitting, and streamed inference
src/rag.ts                    Prompts, token budgets, and citation filtering
src/conversations.ts          Observable store and versioned IndexedDB repository
src/chat-controller.ts        Stage orchestration, cancellation, and retries
src/chat-view.ts               Transcript, composer, sources, and searchable history
src/types.ts                  Shared conversation, retrieval, and worker contracts
```

Runtime workers, connections, and abort controllers are kept outside persisted conversation state. One chat turn runs across the app; conversation, turn, and attempt IDs associate retrieval and worker requests. Late responses are ignored after Stop, collection changes, New chat, or opening another conversation. Initialization retains the shared coordinator, and database operations retain the existing gate.

## Validation and deployment

```sh
npm test
npm run typecheck
npm run build -- --base=/ragbox/
```

Tests cover retrieval, context fitting, worker lifecycle, orchestration, migration, serialized saves, retention, and recovery. A supported-browser smoke test with the real cached model is also required; mocks cannot establish answer quality. See [chat validation](docs/chat-validation.md) for the review sequence and browser checks.

The workflow in `.github/workflows/pages.yml` builds and deploys on pushes to `main` or manual runs. Set GitHub Pages **Source** to **GitHub Actions**. The workflow downloads BEIR NFCorpus and includes the prepared data in `dist/`; Vite's deployment base comes from Pages metadata. Workers, datasets, navigation, and Settings links support deployment under `/ragbox/`.

Each visitor prepares their own browser index and explicitly downloads the optional model. Published-site storage is separate from localhost. `node_modules/`, `dist/`, datasets, and browser data are not committed to this repository.
