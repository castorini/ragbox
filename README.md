# RAGbox

RAGbox is a document chatbot that runs in the browser. DuckDB-Wasm retrieves BM25 matches from NFCorpus or MS MARCO, and an optional local MiniCPM model generates streamed answers with citations. Follow-up questions retrieve fresh evidence using recent conversation context. Retrieval and inference run on the device, without an inference server, API key, or document upload.

## Quick start

Requirements: Node.js `^22.12.0` or `>=24.0.0`, npm, and a browser with OPFS support. Desktop Chrome is the tested target. The optional answer model additionally requires WebGPU with `shader-f16`. Network access is needed for runtime assets and collection/model downloads.

```sh
git clone https://github.com/castorini/ragbox.git
cd ragbox
npm ci
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/), select NFCorpus, and click **Prepare NFCorpus**. Submit `breast cancer` and expand **Sources** to inspect the retrieved articles. Click **Download model (~1.84 GB)** to enable cited answers on a supported GPU.

If you need the source dataset, follow the [installation guide](docs/installation.md#prepare-nfcorpus). Preparation validates all 3,633 BEIR documents and writes the static JSONL input; the browser builds the index. The Pages workflow includes this input in the published demo.

Use the same origin and browser profile on return visits, and keep one RAGbox tab open per origin. `localhost:5173` and `127.0.0.1:5173` have separate storage. Saved indexes and model files are managed in Settings.

## Chat with your documents

- Choose **NFCorpus** for the small nutrition and medical collection, or explicitly download the **MS MARCO** prebuilt index, about 3.35 GB.
- Search with keywords before installing the optional model. With the model ready, ask questions and contextual follow-ups, then inspect each reply's saved sources and citation links.
- Choose **Thinking effort** Off, Low, or Medium. Off is the default; extra reasoning takes longer and does not guarantee a better answer.
- Use **Stop** to retain a partial reply and **Retry** to retry the same turn. Conversations and source snapshots persist across reloads, subject to browser storage availability.

The History page is currently disabled by [HISTORY_ENABLED](src/features.ts); chats still save and restore. Citation links identify supplied evidence, but claims can still be wrong. See [chat validation](docs/chat-validation.md) for recorded browser checks and model limitations.

## Documentation

Start at the [documentation index](docs/README.md) for the complete guide and related Castorini reading.

| Guide | Topics |
| --- | --- |
| [Installation](docs/installation.md) | Requirements, dataset download, local setup, and first search. |
| [Chatting with documents](docs/usage-chat.md) | Follow-ups, citations, reasoning, keyboard controls, Stop, and Retry. |
| [Collections and retrieval](docs/collections.md) | NFCorpus, MS MARCO, BM25 behavior, and native index construction. |
| [Local answer model](docs/local-model.md) | GPU requirements, downloads, thinking effort, context limits, and cache recovery. |
| [Browser storage](docs/storage.md) | OPFS, model cache, saved conversations, origins, retention, and deletion. |
| [Development](docs/development.md) | Commands, architecture, source map, state contracts, and validation. |
| [Deployment](docs/deployment.md) | Static hosting, GitHub Pages, base paths, and MS MARCO configuration. |
| [Troubleshooting](docs/troubleshooting.md) | Setup, download, GPU, search, and persistence recovery. |

The existing [chat validation](docs/chat-validation.md) and [experiment notes](docs/experiments.md) retain implementation observations and historical experiments. Some controls in those records differ from the current interface; the guides above describe current behavior.

## Development and deployment

```sh
npm test
npm run build -- --base=/ragbox/
```

The build runs TypeScript checks and writes `dist/`. Use `npm run typecheck` for a separate type check. Supported-browser checks with the real index and model are needed to validate runtime behavior and answer quality; see [development](docs/development.md#validation).

The [GitHub Pages workflow](.github/workflows/pages.yml) tests, prepares NFCorpus, builds for `/ragbox/`, and deploys on pushes to `main` or manual runs. Set Pages **Source** to **GitHub Actions**. See [deployment](docs/deployment.md) for other base paths and the `VITE_MSMARCO_INDEX_URL` override.

Each visitor owns their browser index, model cache, and saved chats. Generated datasets, `node_modules/`, `dist/`, and browser data are excluded from Git. Runtime and extension downloads mean that local execution does not guarantee fully offline startup.
