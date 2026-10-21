> Historical MS MARCO scaling instructions below refer to controls removed from the current UI. NFCorpus, the local LLM, and OPFS tools remain available.

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
src/main.ts       DuckDB initialization and app startup
src/nfcorpus.ts   NFCorpus import, FTS indexing, and search interface
src/msmarco.ts    Saved MS MARCO index and search interface
src/llm-worker.ts Local answer generation in a Web Worker
src/types.ts      Shared evidence and worker message types
src/style.css     Page styling
scripts/prepare-nfcorpus.ts Dataset validation and preparation
package.json      Dependencies and development commands
package-lock.json Locked dependency versions
```

Start with `main()` in `src/main.ts` to follow initialization, then read the collection modules for search behavior.

## Build and validation

```sh
npm run build
```

The production bundle is generated in `dist/`. A successful build verifies strict TypeScript checks and bundling; persistence and exports require the browser experiments above. `node_modules/` and `dist/` are excluded from Git, and browser OPFS data is not part of the repository.

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

The module is in `src/nfcorpus.ts`. Query text is passed as a bound parameter. Displayed document content uses text nodes. The index button explicitly rebuilds an existing index; it does not replace an existing corpus table. FTS indexes do not automatically track table edits.

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

After building the NFCorpus index, the page can generate a cited answer locally from the BM25 results. This is an optional second stage: DuckDB still performs retrieval, and the original ranked result list remains visible.

Click **Load local LLM (~1.84 GB)** to download the quantized [MiniCPM5-2B ONNX model](https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX). The model runs in a Web Worker through [Transformers.js](https://huggingface.co/docs/transformers.js) with WebGPU and `q4f16` weights. The first download is large and requires a desktop browser whose WebGPU adapter exposes `shader-f16`; Chrome with a supported GPU is the tested target. The model is cached by the browser for later visits, subject to normal browser cache eviction and storage quotas.

When the model is ready, submit an NFCorpus search as usual. The application passes the highest-ranked retrieved documents (within a fixed prompt budget) to the model and streams a grounded answer. Factual claims should cite document IDs such as `[MED-14]`; citation links jump to the corresponding result. Document text is treated as quoted evidence, not instructions, and answer rendering uses text nodes rather than HTML. If WebGPU is unavailable, the full BM25 search remains usable without downloading the model.

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

## MS MARCO scaling experiment

Use the **MS MARCO scaling experiment** section to measure passage retrieval at increasing corpus sizes. Select a local MS MARCO passage `collection.tsv`, choose 10,000, 100,000, 1,000,000, or all passages, then click **Import MS MARCO & build index**. The browser reads batches of 2,000 records; the source file is not uploaded or included in the GitHub Pages build.

The experiment uses a deterministic prefix of the file, not a random sample. Each import replaces only the `msmarco` table and its FTS index. NFCorpus and its LLM integration remain separate. The index is built over passage text using DuckDB FTS defaults. Each passage retains its original ID. Search uses bound query parameters and returns up to ten matches ranked by BM25.

If the corpus is in cloud-backed storage on macOS, download it locally before selecting it. A visible file name and size do not guarantee that its contents are available; a `dataless` file may block on downloading when read.

Suggested procedure:

1. Start with 10,000 passages and leave the LLM unloaded. Record browser, machine RAM, and other active applications separately.
2. Search for `what is a corporation`, then repeat the same query several times. The first run and later runs may differ due to caching.
3. Download the session measurements before reloading. The JSON log is held in page memory; the table/index are persisted in OPFS.
4. Reload and search without reimporting to check persistence.
5. Repeat at 100,000 passages, then 1,000,000 if feasible. Attempt the full corpus only after smaller runs succeed.

Measurements include source size, actual imported row count, engine version, import time, index time, checkpoint time, and query time. Query time includes statement preparation, execution, result transfer, and statement cleanup, but excludes DOM rendering. Storage usage/quota estimates apply to the whole origin, including other demo tables and cached models; they are not per-index sizes or peak memory measurements. Use Chrome Task Manager to observe memory separately. These are exploratory measurements, not retrieval-quality evaluation or controlled performance benchmarks.

A partial import after an error is not a completed experiment. Reimport to retry. Batching bounds JavaScript input buffers but does not bound DuckDB-Wasm's memory use during index construction. Million-passage and full-corpus runs are experimental and have not been validated in a browser. A tab crash may lose the in-memory measurement log. **Reset all data** also deletes the MS MARCO table/index because they live in the shared demo database.

Implementation: `src/msmarco-stream.ts` handles streaming TSV parsing; `src/msmarco.ts` handles import, indexing, results, and measurement download. Building in the browser requires a local `collection.tsv`; visitors can instead download the prebuilt index described below.

## Build MS MARCO FTS outside the browser

To separate indexing memory requirements from browser query requirements, build a native database and copy it into OPFS. The builder pins DuckDB 1.4.3 to match the engine reported by this browser demo. Install [uv](https://docs.astral.sh/uv/) or use a Python environment with `duckdb==1.4.3`.

```sh
uv run --with duckdb==1.4.3 python scripts/build-msmarco.py /path/to/collection.tsv artifacts/msmarco-prebuilt.duckdb
```

The script refuses to overwrite existing output, imports passages, builds the default FTS index, checkpoints, runs a sample search, and closes the database. A neighboring `.build.json` records row count, native timings, configuration, and completion/failure. Defaults are a 4 GB buffer memory limit, two threads, and up to 6 GB temporary spill space; the memory setting is not a hard cap on process memory. Reserve disk space for the database and spill files. Optional `--limit 10000` supports a smaller smoke test; `--memory` and `--threads` adjust native build settings. Generated artifacts and downloaded native extensions are ignored by Git.

After the script reports `"status": "complete"`:

1. Reload the browser lab after any previous out-of-memory failure.
2. Under **Use an index built outside the browser**, choose `artifacts/msmarco-prebuilt.duckdb`.
3. Click **Copy & open prebuilt index**. The file is streamed directly to OPFS, not uploaded or buffered whole in JavaScript memory.
4. Wait for the passage count, then search. **Search database** switches to **Prebuilt native index** after a successful open.
5. Download measurements. After reload, click **Reopen saved prebuilt index** to reuse the OPFS copy without selecting the source file again.

The prebuilt database opens read-only in a separate DuckDB-Wasm worker. It must contain `main.msmarco(id, contents)` and the saved `fts_main_msmarco` index/macro. Opening validates the table and retrieval macro. FTS extension code is loaded in the browser; it is not bundled into the native database. The existing browser-built MS MARCO experiment remains available through the source selector. **Checkpoint & close** releases both workers; **Reset all data** deletes both database files.

This moves index construction out of the browser; it does not guarantee full-corpus search will fit within browser memory. Record opening and query errors as experimental outcomes. Native build timings and browser query timings are different measurements and should be reported separately. The multi-GB database is not included in the GitHub Pages deployment.

### Initial native full-corpus result

A local DuckDB 1.4.3 run with the default builder settings completed on all **8,841,823 passages**: import took **42.4 s**, FTS construction **310.8 s**, and the single sample query `what is a corporation` **2.73 s**. The checkpointed database was **3,346,542,592 bytes**. These are one-run native observations, not browser timings or a controlled benchmark. Full-corpus browser querying of the prebuilt file remains to be verified.

### Configure the public prebuilt-index download

**Download & open MS MARCO index (~3.35 GB)** streams a hosted database directly into OPFS, reports progress, supports cancellation, checks the expected byte count, and opens the saved index. Failed or cancelled writes are aborted instead of committing a partial replacement. The size check detects incomplete transfers; it is not a cryptographic integrity check. The default download uses the public [MS MARCO DuckDB FTS dataset](https://huggingface.co/datasets/DavidzzzZZZ/msmarco-duckdb-fts), pinned to revision `d8b39bc9edc94a16fb77359243163ed80c609c84`. No account or local corpus file is required for visitors.

The database must be hosted separately with HTTPS and CORS allowing requests from the demo origin. Use a direct file URL, not an HTML preview page. GitHub release assets must be smaller than 2 GiB, so the 3.35 GB file cannot be hosted as one release asset. A public Hugging Face dataset repository is one hosting option. The URL is public configuration and must not contain credentials.

No configuration is needed to use the default download. To override it for local testing, create `.env.local`:

```text
VITE_MSMARCO_INDEX_URL=https://your-host.example/msmarco-prebuilt.duckdb
```

Restart Vite after changing it. For GitHub Pages, add the repository Actions variable **MSMARCO_INDEX_URL** under **Settings → Secrets and variables → Actions → Variables**, then rerun the deployment. The Pages workflow passes it to Vite at build time.

The expected artifact size is currently 3,346,542,592 bytes. If publishing a different build, update `downloadBytes` in `src/msmarco.ts` as well. Visitors need browser storage for the downloaded file; replacing an existing copy may temporarily require additional disk space. Downloads do not resume across reloads. After a completed download, use **Reopen saved prebuilt index** on later visits.
