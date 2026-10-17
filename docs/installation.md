# RAGbox: Installation

This guide takes you from a checkout to a local NFCorpus search. All commands run from the repository root unless a step says otherwise.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | `^22.12.0` or `>=24.0.0`, as declared in [package.json](../package.json). |
| npm | Used to install the locked dependencies and run the project scripts. |
| Browser | A modern browser with the Origin Private File System (OPFS), workers, IndexedDB, and Cache Storage. Desktop Chrome is the tested target. |
| Local answer generation | A WebGPU adapter exposing `shader-f16`. Keyword search works without the model. |
| Network | Needed for dependency installation, DuckDB runtime and extension assets, and collection/model downloads. |

Serve the application on HTTPS or a loopback address such as `http://127.0.0.1:5173/`. Opening `index.html` as a local file is not a supported setup. The browser application requires no Python environment, Java installation, API key, or inference server. Python is only needed if you choose to [build an MS MARCO index yourself](collections.md#building-an-ms-marco-index-with-native-duckdb).

## Install the application

```sh
git clone https://github.com/castorini/ragbox.git
cd ragbox
npm ci
```

If you already have a checkout, run `npm ci` in that directory. The lockfile pins the dependency graph; the main runtime dependencies are DuckDB-Wasm, Transformers.js, and Zustand.

## Prepare NFCorpus

NFCorpus contains 3,633 nutrition and medical documents. The same BEIR archive is used by the [QuackIR NFCorpus walkthrough](https://github.com/castorini/quackir/blob/main/docs/experiments-nfcorpus.md) and RAGbox's deployment workflow.

Download and extract it into a temporary directory:

```sh
ragbox_data_dir="$(mktemp -d)"
curl --fail --location --retry 3 \
  https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip \
  --output "$ragbox_data_dir/nfcorpus.zip"
unzip -q "$ragbox_data_dir/nfcorpus.zip" -d "$ragbox_data_dir"
npm run prepare:nfcorpus -- "$ragbox_data_dir/nfcorpus/corpus.jsonl"
```

Alternatively, use an existing BEIR copy:

```sh
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
```

The preparation script requires exactly 3,633 unique documents with string `_id`, `title`, and `text` fields. It writes `public/data/nfcorpus.jsonl` with `id`, `title`, and `text` fields and prints:

```text
Prepared 3633 documents for browser import.
```

This step prepares a static data file. The browser builds the search index later. Generated JSONL files are ignored by Git and must be prepared separately in each checkout or build environment.

## Start the development server

```sh
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). The development server binds to `127.0.0.1`, uses port `5173`, and fails if that port is already occupied.

1. Wait for startup checks to finish.
2. Select the NFCorpus collection card and click **Prepare NFCorpus**. The equivalent Settings action is **Set up collection**.
3. Wait for the collection to become ready with 3,633 documents.
4. Enter `breast cancer` and submit. Expand **Sources** to inspect the retrieved articles and BM25 scores.
5. Reload the page and search again. The saved index should reopen without importing the dataset again.

Keep one RAGbox tab open per origin. Use the same browser profile, scheme, host, and port on later visits: `localhost:5173` and `127.0.0.1:5173` have separate browser storage.

## Enable cited answers

On a supported GPU, click **Download model (~1.84 GB)** on the start page or in Settings. Downloading and GPU initialization are separate stages. Once the model is ready, new messages generate cited answers, and follow-up questions can use recent conversation context.

See [chatting with documents](usage-chat.md) for a walkthrough and [the model guide](local-model.md) for thinking effort, context limits, and recovery. The [troubleshooting guide](troubleshooting.md) covers missing datasets, unsupported browsers, and download failures.

## Verify a production build

```sh
npm test
npm run build -- --base=/ragbox/
```

The build runs the TypeScript checks and writes static assets to `dist/`. Browser index creation and WebGPU inference still need a browser check. See [development](development.md#validation) and [deployment](deployment.md) for the full workflow.

[Documentation](README.md)
