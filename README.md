# DuckDB-Wasm OPFS Lab

A small browser-based lab demonstrating persistent SQL databases and NFCorpus full-text search with DuckDB-Wasm and the Origin Private File System (OPFS). Build an FTS index over 3,633 documents, search with BM25, query saved tables after a page reload, and export data for use with native DuckDB.

Based on DuckDB’s article [Persistent Databases in the Browser with DuckDB-Wasm and OPFS](https://duckdb.org/2026/09/18/opfs-wasm) (September 18, 2026). This repository adapts the article’s examples into an interactive page and adds a separate local-query experiment.

## Getting started

Prerequisites:

- Node.js 22 or later and npm.
- A modern browser with OPFS support. The walkthrough has been exercised in Chrome.
- Internet access to load the DuckDB worker and WebAssembly files from the CDN, and to import the remote orders dataset.

From the repository directory, run:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173/**. Native DuckDB is optional and is needed only to inspect exports outside the browser.

The development server serves the application; SQL queries execute inside the browser in a Web Worker. Database files are stored in the browser’s OPFS, not in the repository directory.

## Experiments

### 1. Persist transactions across reloads

On each page load, the application opens `opfs://analytics.duckdb`, creates the `transactions` table if necessary, inserts one sample purchase, and runs `CHECKPOINT`. The page displays the stored transactions.

Click **Reload page**. The previous rows should remain, with one additional row. To test an explicit shutdown, click **Checkpoint & close**, then reload to reopen the database.

Each sample purchase intentionally uses `id = 1`, matching the article. The table has no primary-key constraint, so duplicate IDs are allowed.

### 2. Import orders and cache monthly totals

Click **Load orders & cache monthly totals**. This button:

1. Runs the article’s `CREATE TABLE IF NOT EXISTS orders AS SELECT ...` statement against a remote Parquet dataset.
2. Checkpoints the database.
3. Aggregates orders by month and priority.
4. Writes the totals to `opfs://cache/monthly_totals.parquet` and reads back the first ten results.

The aggregation is recomputed and the Parquet cache is rewritten on every click.

**Observed difference from the article:** in the tested Chrome setup with DuckDB-Wasm 1.32.0, rerunning the import statement after a reload produced remote requests even when `SHOW TABLES` confirmed that `orders` already existed. The internal cause has not been established. `IF NOT EXISTS` should therefore not be treated as a guarantee of zero network access in this example.

### 3. Query the saved table without importing again

After importing orders, reload the page and wait for **Ready**. Open the browser’s Network panel, filter by `orders.parquet`, and click **Query saved orders (local only)**.

Monthly totals should appear without new requests matching that filter. This button queries `orders` directly; it does not submit the remote import statement or read the exported Parquet cache.

This demonstrates reuse of persisted data. It does not demonstrate fully offline startup: the application still loads DuckDB’s worker and WebAssembly files from a CDN.

### 4. Export the database

Click **Download analytics.duckdb**. The application checkpoints the database and downloads its main file through the browser’s OPFS API.

The export includes both database tables, `transactions` and `orders` (if imported). The separate Parquet cache is not included.

With native DuckDB installed, open the downloaded file:

```sh
duckdb /path/to/analytics.duckdb
```

Then inspect its contents:

```sql
SHOW TABLES;
SELECT count(*) AS transaction_count FROM transactions;
SELECT count(*) AS order_count FROM orders;
```

### 5. Export a table as Parquet

Click **Download transactions.parquet** to export the transaction table with Zstandard compression. Native DuckDB can query the downloaded file directly:

```sql
SELECT *
FROM read_parquet('/path/to/transactions.parquet')
ORDER BY ts
LIMIT 5;
```

Both downloads are snapshots. Later browser changes do not update previously downloaded files. Reloading between exports also adds another transaction, so exports made at different times may have different row counts.

## Storage and implementation notes

- **Origin-specific storage:** use the same browser profile and exact URL when testing persistence. Changing the scheme, host, or port selects a different storage origin.
- **One tab at a time:** OPFS file handles are exclusive; close other instances of the lab before opening the same database.
- **Checkpoints:** the application explicitly checkpoints after database writes and before database export or clean shutdown. It does not rely on an asynchronous page-unload handler.
- **Automatic file handling:** `opfs: { fileHandling: 'auto' }` manages the OPFS Parquet paths used in SQL.
- **Version pin:** DuckDB-Wasm is pinned to `1.32.0`, a version tested by the article. The article reports an OPFS path regression in `1.33.1-dev57.0`.
- **Storage lifetime:** browser storage can be cleared or evicted. Export data that needs an independent copy.
- **Display formatting:** some SQL values are converted to strings for readable JSON output; this does not change their stored column types.

## Project structure

```text
index.html        Page layout and experiment buttons
src/main.js       DuckDB initialization, SQL queries, and exports
src/nfcorpus.js   NFCorpus import, FTS indexing, and search interface
src/style.css     Page styling
scripts/prepare-nfcorpus.mjs Dataset validation and preparation
package.json      Dependencies and development commands
package-lock.json Locked dependency versions
```

Start with `main()` in `src/main.js` to follow initialization, then read the button handlers for each experiment.

## Build and validation

```sh
npm test
npm run build
```

The test suite covers retrieval/RAG integration and the production bundle is generated in `dist/`. Persistence, WebGPU inference, answer quality, and exports still require the browser experiments above. `node_modules/` and `dist/` are excluded from Git, and browser OPFS data is not part of the repository.

## NFCorpus full-text search in the browser

The NFCorpus section demonstrates the [DuckDB FTS extension](https://duckdb.org/docs/current/core_extensions/full_text_search) on 3,633 documents. Import, index construction, and BM25 search execute in DuckDB-Wasm; there is no search backend.

Prepare the dataset from an existing BEIR NFCorpus `corpus.jsonl`:

```sh
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
npm run dev
```

The preparation script validates document IDs and copies title/text fields to `public/data/nfcorpus.jsonl`. It does not build a search index. Generated dataset files are excluded from Git; each checkout needs this preparation step. The source dataset is described in the [QuackIR NFCorpus guide](https://github.com/castorini/quackir/blob/main/docs/experiments-nfcorpus.md).

1. Open the lab and wait for Ready.
2. Click **Load NFCorpus & build FTS index**. The application installs/loads `fts`, imports the local JSONL file if the table is missing, indexes combined title and text using the extension defaults, and checkpoints.
3. Search for `breast cancer`. Results show document IDs, titles, BM25 scores, excerpts, and expandable full text. Higher scores appear first, with document ID breaking ties.
4. Try a different query or an unlikely term to exercise the no-match case.
5. Reload and search again without rebuilding. The table and index are stored in the existing OPFS database; the FTS extension is loaded again for the new session.

The module is in `src/nfcorpus.js`. Query text is passed as a bound parameter. Displayed document content uses text nodes. The index button explicitly rebuilds an existing index; it does not replace an existing corpus table. FTS indexes do not automatically track table edits.

### Core FTS operations

After importing documents into `nfcorpus`, with `contents` formed by concatenating title and text, the browser executes:

```sql
INSTALL fts;
LOAD fts;
PRAGMA create_fts_index('nfcorpus', 'id', 'contents', overwrite = 1);
```

`create_fts_index` is the key setup step: it indexes `contents`, associates entries with document `id`, and creates the retrieval macro used by the search query:

```sql
SELECT id, title, text,
       fts_main_nfcorpus.match_bm25(id, ?) AS score
FROM nfcorpus
WHERE score IS NOT NULL
ORDER BY score DESC, id
LIMIT 10;
```

The application binds the user's search text to `?` through a prepared statement. A `NULL` score indicates no match; matching documents are ranked by descending BM25 score.

### Verified browser behavior

In the Chrome walkthrough, all 3,633 documents were indexed successfully. Searching for `breast cancer` returned ten results, led by `MED-14` (3.5702) and `MED-3551` (3.5589), matching the first two results from the native DuckDB SQL check. The browser reported DuckDB engine version `v1.4.3`; this is distinct from the JavaScript package version. Displayed query timings include rendering and are not standalone search benchmarks. Index reuse after reload remains a separate verification step in the walkthrough.

Internet access is still needed for DuckDB runtime/extension downloads. A successful native SQL check or Vite build does not verify that the browser can download and load its matching Wasm extension. Extension errors appear in the FTS status message. Retrieval evaluation against NFCorpus relevance judgments is outside this demo.

## Local LLM answers (browser RAG)

The page can generate a cited answer locally from either corpus's BM25 results. This is an optional second stage: DuckDB still performs retrieval, and each corpus keeps its own answer panel beside the original ranked result list.

Click **Load local LLM (~1.84 GB)** to download the quantized [MiniCPM5-2B ONNX model](https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX). The model runs in a Web Worker through [Transformers.js](https://huggingface.co/docs/transformers.js) with WebGPU and `q4f16` weights. The first download is large and requires a desktop browser whose WebGPU adapter exposes `shader-f16`; Chrome with a supported GPU is the tested target. The model is cached by the browser for later visits, subject to normal browser cache eviction and storage quotas.

The application loads one shared model worker. When the model is ready, submit an NFCorpus or MS MARCO search as usual. The application passes the highest-ranked retrieved evidence that fits the fixed prompt budget to the model and streams the answer into that corpus's panel. Factual claims should cite IDs such as `[MED-14]` or `[MARCO-123]`; links are enabled only for evidence included in the fitted model context and jump to the corresponding result. Starting a new search cancels any active generation, while late worker output is ignored. Retrieved text is treated as quoted evidence, not instructions, and answer rendering uses text nodes rather than HTML. If WebGPU is unavailable, both BM25 searches remain usable without downloading the model.

The model runs entirely on the device. No API key, inference server, or document upload is used. **Reset all data** removes the DuckDB database and demo Parquet files but does not intentionally remove the model from the browser cache. The model and its base model are Apache-2.0 licensed; review the model card before redistributing weights.

## Publish on GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and deploys the demo on pushes to `main`, or when triggered manually from Actions.

1. In the repository's **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
2. Commit and push the workflow to `main`.
3. Open **Actions → Deploy demo to GitHub Pages** and wait for the build and deployment to succeed. The deployment provides the public site URL.

The workflow downloads the BEIR NFCorpus archive, runs the preparation script, and includes the generated dataset in the published `dist/` artifact. The dataset does not need to be committed. Vite's base path is set from GitHub Pages metadata so scripts and dataset requests resolve under the repository URL.

Each visitor builds their own FTS index in their browser. Storage on the published origin is separate from localhost, so the first visit requires clicking **Load NFCorpus & build FTS index**. The workflow depends on availability of the dataset download; the browser also requires the DuckDB runtime and extension CDNs.

## Reset all demo data

Click **Reset all data** and confirm to close DuckDB, delete `analytics.duckdb` and its WAL/helper files, and remove the demo's OPFS Parquet cache and export. All tables and FTS indexes in that database are removed. The button also works after **Checkpoint & close**. Close other tabs running the demo before resetting.

The page reloads after deletion. Startup creates a fresh `transactions` table with one sample row, as on a first visit. NFCorpus and orders remain absent until imported again; searching before rebuilding displays the missing-index message. Downloaded files, repository data, and unrelated files on the same origin are unaffected. Localhost and the hosted site have separate storage, so reset each separately if needed.

## MS MARCO search

### Using the saved index

1. Open the app in a supported desktop browser, such as Chrome.
2. Click **Download & open index (3.35 GB)** and wait for it to finish. Keep the tab open while downloading.
3. Enter a query and click **Search** to see up to ten matching passages. If the shared local model is loaded, a cited answer appears above them using `[MARCO-…]` citations.
4. After reloading or returning later, click **Reopen saved index** before searching. No second download is needed while the saved file remains in browser storage.

The index is stored in the browser’s Origin Private File System (OPFS), not the Downloads folder. Localhost and the public site have separate storage. Clearing browser storage removes the saved index. Downloads can be cancelled but cannot resume across reloads. Allow sufficient free disk space; replacing an existing index can temporarily require additional space.

No Hugging Face account or local `collection.tsv` is needed. Internet access is required to download the index and load DuckDB runtime and extension assets. Search itself executes on the visitor’s computer. Full-corpus queries can take several seconds, depending on the device and query.


The MS MARCO section uses the prebuilt index only. Local TSV import, browser index building, source selection, and benchmark controls have been removed from the UI. NFCorpus, the local LLM, and OPFS experiments remain available.

For native index construction and previous scaling measurements, see [the experiment notes](docs/experiments.md).
