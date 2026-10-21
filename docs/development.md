# RAGbox: Development Guide

RAGbox is a TypeScript application built with Vite. It uses direct DOM views, Zustand vanilla stores, DuckDB-Wasm for retrieval, and Transformers.js for local inference. Start with [installation](installation.md) to prepare a checkout and NFCorpus.

## Commands

Run commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies from the lockfile. |
| `npm run prepare:nfcorpus -- /path/to/corpus.jsonl` | Validate and prepare the static NFCorpus input. |
| `npm run dev` | Start Vite at `http://127.0.0.1:5173/` with a strict port. |
| `npm test` | Run the Vitest suite once. |
| `npm run typecheck` | Check application, worker, test, and Node-script TypeScript configurations. |
| `npm run build` | Run type checks and build `dist/` for the default root path. |
| `npm run build -- --base=/ragbox/` | Run type checks and build for the Pages subpath. |
| `npm test -- test/collection-retrieval.test.ts` | Run a focused test file. |

Vitest uses a Node environment and the files under `test/`. Browser APIs and DOM behavior are represented with focused fakes where needed. Runtime versions are pinned in [package.json](../package.json); use the supported Node range there.

## Request flow

```mermaid
flowchart LR
  UI[Chat view] --> C[Chat controller]
  C --> Q[Resolve follow-up with local model]
  C --> D[DuckDB BM25 retrieval]
  Q --> D
  D --> E[Fit current evidence to token budget]
  E --> A[Stream local model answer]
  A --> UI
  C --> S[Conversation store]
  S --> P[Serialized IndexedDB persistence]
```

The first message skips query rewriting. When no model is ready, the controller performs literal keyword retrieval and retains the results for inspection or a later answer. An empty result set produces an insufficient-evidence reply without answer generation.

For contextual follow-ups, the model receives bounded recent history and produces a standalone query. Retrieval then uses the selected saved index's analyzer and stopwords before a parameterized BM25 query. The answer worker fits the new evidence to its token budget, separates reasoning from final text, and reports allowed citation IDs. See [collections](collections.md#how-retrieval-works) and [the model guide](local-model.md#context-and-output-limits) for the actual limits.

## Source map

| Area | Files and responsibilities |
| --- | --- |
| Startup and navigation | [main.ts](../src/main.ts) initializes DuckDB, collection adapters, model services, stores, and views. [collection-chooser.ts](../src/collection-chooser.ts) coordinates routes and selection. |
| Retrieval | [collection-retrieval.ts](../src/collection-retrieval.ts) normalizes queries and executes BM25. [nfcorpus.ts](../src/nfcorpus.ts) prepares and reopens NFCorpus. [msmarco.ts](../src/msmarco.ts), [prebuilt-msmarco.ts](../src/prebuilt-msmarco.ts), and [download-prebuilt.ts](../src/download-prebuilt.ts) manage the saved MS MARCO artifact. |
| Database lifecycle | [open-local-database.ts](../src/open-local-database.ts) registers OPFS handles for the database and WAL before opening DuckDB. [load-coordinator.ts](../src/load-coordinator.ts) serializes resource initialization. |
| Model lifecycle | [model-service.ts](../src/model-service.ts) owns DOM-independent capability checks, loading, cancellation, and inference requests. [llm-controller.ts](../src/llm-controller.ts) connects model controls and compatibility views. |
| Worker and prompts | [llm-worker.ts](../src/llm-worker.ts) loads the pinned model and handles rewriting, context fitting, and streaming. [rag.ts](../src/rag.ts) defines prompts, evidence/history fitting, query validation, and citation extraction. |
| Reasoning and budgets | [generation-output.ts](../src/generation-output.ts) separates reasoning and final output across streamed chunks. [generation-budget.ts](../src/generation-budget.ts) tracks separate limits. [thinking-effort.ts](../src/thinking-effort.ts) defines supported effort values. |
| Model cache | [model-cache.ts](../src/model-cache.ts) defines the model/revision and scoped cache operations. [model-readiness.ts](../src/model-readiness.ts) checks required files and metadata. |
| Conversation state | [conversations.ts](../src/conversations.ts) owns the Zustand store, versioned IndexedDB repository, migration, and retention. [conversation-persistence.ts](../src/conversation-persistence.ts) serializes saves and streaming checkpoints. |
| Chat orchestration | [chat-controller.ts](../src/chat-controller.ts) handles turn stages, retries, resource recovery, and cancellation. [types.ts](../src/types.ts) defines conversation, evidence, operation, and worker contracts. |
| Views and onboarding | [chat-view.ts](../src/chat-view.ts) renders transcripts, sources, composer, and History. [corpus-dashboard.ts](../src/corpus-dashboard.ts), [example-queries.ts](../src/example-queries.ts), and [tour.ts](../src/tour.ts) provide their corresponding controls. |
| Resource controls | [resource-state.ts](../src/resource-state.ts) provides shared resource snapshots and the operation gate. [settings-view.ts](../src/settings-view.ts), [storage-dashboard.ts](../src/storage-dashboard.ts), and [reset.ts](../src/reset.ts) manage Settings and scoped deletion. |

## State and lifecycle contracts

There is one active chat operation across the application. Conversation, turn, and attempt identities associate retrieval and worker events with their request. Late responses must be ignored after Stop, a collection change, New chat, or opening another conversation.

Runtime workers, database connections, and abort controllers live outside persisted state. Conversation reads are pure. Unchanged turns retain object identity, and selector subscriptions keep draft/control changes from rerendering the transcript. Equivalent resource snapshots are deduplicated. The controller observes resource transitions directly, so resuming pending work does not depend on a view rendering first.

Persistence preserves ordering, one-second streaming checkpoints, migration markers, and retention of 50 nonempty conversations. Reload must restore interrupted turns as Stopped and must not restart inference. Settings navigation preserves ongoing work; changing collections cancels it. Retries reuse the turn and its submitted effort while rerunning only the stages required by the failure.

Prompt evidence is untrusted data. Render document and model output as text, bind query values through prepared statements, and limit citation links to the fitted evidence IDs. Keep reasoning out of copy output and follow-up context. These contracts are covered by the existing test suites and [chat validation](chat-validation.md).

## Feature configuration

`HISTORY_ENABLED` in [src/features.ts](../src/features.ts) is currently `false`. Enabling it restores the History navigation link, page, and tour step; conversations persist in either mode. When following older validation notes, account for that flag and for thinking now being always off (the switch was removed).

`VITE_MSMARCO_INDEX_URL` changes the artifact URL at startup/build time. The expected size is a separate code constant. Model identity and revision are also code constants; changing them requires reviewing required cache files and template compatibility. See [deployment](deployment.md#configure-the-ms-marco-download) and [the model guide](local-model.md).

## Validation

For a normal change, run the checks relevant to the affected code. Before reviewing the full application or deployment path, use:

```sh
npm test
npm run typecheck
npm run build -- --base=/ragbox/
```

The build already runs type checking; the standalone command is useful for quicker diagnostics. Tests cover retrieval, orchestration, stale events, retries, model/cache recovery, reasoning parsing, token budgets, state subscriptions, persistence, and control behavior. Mocks cannot establish live answer quality or GPU compatibility.

For a supported-browser smoke check:

1. Prepare NFCorpus and verify retrieval and source inspection before loading the model.
2. With a real ready model, check an answer and a contextual follow-up, comparing factual claims with the cited snapshots.
3. Exercise Stop, Retry, draft editing, Settings navigation, collection switching, and reload restoration.
4. Check folded reasoning, copy output, source anchors, focus, scrolling, and a narrow viewport.
5. Exercise the built application under `/ragbox/` to catch worker and dataset path errors. Test MS MARCO when a valid artifact is already available or an explicit download is intended.

Use the detailed [existing checklist](chat-validation.md#repeatable-manual-checks) with its historical UI differences in mind. Run destructive storage checks only with disposable browser data. The [experiment notes](experiments.md) retain earlier scaling measurements; label new observations with browser, device, collection, and model revision instead of treating a single run as a benchmark.

[Documentation](README.md)
