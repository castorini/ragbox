# RAGbox: Collections and Retrieval

RAGbox searches two built-in collections. Both use DuckDB's full-text search (FTS) extension and execute BM25 retrieval in a browser worker.

| Collection | Content | Setup | Browser database |
| --- | --- | --- | --- |
| NFCorpus | 3,633 nutrition and medical documents | Import the prepared JSONL file and build an index in the browser. | `analytics.duckdb`, opened read/write. |
| MS MARCO | The default prebuilt index contains 8,841,823 passages. | Explicitly download a prebuilt database, about 3.35 GB. | `msmarco-prebuilt.duckdb`, opened read-only. |

The files live in the Origin Private File System (OPFS), scoped to the site's origin and browser profile. See [browser storage](storage.md) for persistence and removal.

## NFCorpus

### Prepare the static dataset

Use the [installation guide](installation.md#prepare-nfcorpus) to obtain the BEIR NFCorpus archive, then run:

```sh
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
```

[scripts/prepare-nfcorpus.ts](../scripts/prepare-nfcorpus.ts) validates exactly 3,633 unique string IDs and string title/text fields. It converts BEIR's `_id` to `id` and writes one JSON object per line to `public/data/nfcorpus.jsonl`:

```json
{"id":"MED-example","title":"Example title","text":"Example document text."}
```

The example shows the output schema; the preparation script expects the actual full collection. It preserves titles and text separately and does not build an index.

### Build and reopen the index

Click **Prepare NFCorpus** on the start page or **Set up collection** in Settings. The collection adapter:

1. Installs and loads the `fts` extension.
2. Fetches `data/nfcorpus.jsonl` relative to the deployment base when the table is absent.
3. Creates `nfcorpus` with `id`, `title`, `text`, and `contents`, combining title and text into `contents`.
4. Builds the index and checkpoints the database.

The indexing statement in [src/nfcorpus.ts](../src/nfcorpus.ts) is:

```sql
PRAGMA create_fts_index('nfcorpus', 'id', 'contents', overwrite = 1);
```

The saved table and index reopen on later visits. Older tables containing `id` and `contents` are supported by synthesizing a display title and using `contents` as the document text.

FTS indexes do not automatically track table edits. The setup path rebuilds the index over an existing table; replacing the prepared JSONL alone does not replace a table already stored in the browser. Use Settings to remove the relevant database before importing a replacement. [Delete index data](storage.md#remove-saved-data) removes both collections, so use the individual file controls when appropriate.

## MS MARCO

### Download and open the prebuilt index

Select MS MARCO and click **Download MS MARCO index (3.35 GB)**. Confirm the browser-storage download and keep other RAGbox tabs closed. The application checks the estimated available quota, streams the response into OPFS, then opens the saved database and validates its FTS retrieval macro.

The default artifact is pinned in [src/msmarco.ts](../src/msmarco.ts) to a revision of the [MS MARCO DuckDB FTS dataset](https://huggingface.co/datasets/DavidzzzZZZ/msmarco-duckdb-fts/tree/d8b39bc9edc94a16fb77359243163ed80c609c84). Its expected length is **3,346,542,592 bytes**. Progress first reports transfer bytes and then index opening. Allow additional space for browser storage overhead and the optional model.

A saved index opens when MS MARCO is selected. If automatic opening fails, use the offered open/retry action; this can recover a saved file without another download. To download a fresh copy, delete the saved file in Settings' **Advanced file management**, then download again.

**Cancel download** aborts the staged write. Cancelling a replacement preserves the previously committed file, which can be reopened. Partial downloads do not resume after a page reload. A completed transfer followed by an opening failure is different from a failed transfer: try reopening before replacing it.

### Host a compatible artifact

`VITE_MSMARCO_INDEX_URL` overrides the default URL at development-server startup or build time. The value must point directly to the database bytes and use HTTPS, or HTTP on `localhost`/`127.0.0.1`. Cross-origin hosting must allow the browser's fetch through CORS.

The override changes only the URL. The expected byte count remains fixed in `src/msmarco.ts`, and the downloader rejects shorter or longer files. Hosting a different database therefore also requires updating that count and the displayed size. The database must have a `msmarco` table with `id` and `contents`, a compatible `fts_main_msmarco` schema including its analyzer and stopwords, and `match_bm25`.

See [deployment](deployment.md#configure-the-ms-marco-download) for environment-variable examples.

### Building an MS MARCO index with native DuckDB

The browser UI uses the prebuilt artifact. To create a compatible database outside the browser, use [scripts/build-msmarco.py](../scripts/build-msmarco.py) with an existing MS MARCO passage `collection.tsv`. The input is `id<TAB>passage` per line; literal quotes are treated as text.

With Python and `uv` available, a small deterministic prefix build is:

```sh
uv run --with duckdb==1.4.3 python scripts/build-msmarco.py \
  /path/to/collection.tsv /path/to/output/msmarco-10k.duckdb \
  --limit 10000 --memory 4GB --threads 2
```

Omit `--limit` to build the full corpus, after checking the [historical scaling notes](experiments.md#ms-marco-scaling-experiment) and available resources. The script requires DuckDB **1.4.3**, matching the tested browser engine; DuckDB-Wasm's npm package version **1.32.0** is a separate version number.

The script refuses an existing output path. It imports passages, builds FTS over `contents`, checkpoints, tests a query, and records counts, timings, example results, and status in a sibling `.build.json` report. It uses an output-adjacent temporary directory with a configured 6 GB limit and an `.extensions` directory for native extensions.

The generated database is not automatically served or imported by the application. To use it through the download workflow, host it and update the URL and exact size as described above. The old local-file import and scaling controls in the experiment notes are historical.

## How retrieval works

[src/collection-retrieval.ts](../src/collection-retrieval.ts) handles chat retrieval for both collections:

1. Tokenize the literal or resolved query using the saved index's analyzer.
2. Remove that index's stopwords before BM25 stemming. A query containing only removed tokens returns no documents.
3. Bind the normalized text as a prepared-statement parameter to `match_bm25`.
4. Return at most ten matches, ordered by descending score and then document ID.

For NFCorpus, the ranking statement is:

```sql
SELECT id, title, text,
       fts_main_nfcorpus.match_bm25(id, ?) AS score
FROM nfcorpus
WHERE score IS NOT NULL
ORDER BY score DESC, id
LIMIT 10;
```

The `?` receives the normalized query. Normalization runs as a separate small statement so that the large retrieval macro receives a plain bound value. The original message and resolved query remain available in the saved turn and Sources; normalization does not rebuild the index.

MS MARCO uses the equivalent macro over `msmarco.contents`. Displayed passage IDs receive a `MARCO-` prefix for citations; the stored database IDs remain unchanged. BM25 scores describe ranking within a query, not the reliability of a document or answer.

The application retrieves ten candidates and fits evidence to the [model's context budget](local-model.md#context-and-output-limits). There is currently no dense retrieval, reranking, arbitrary document-upload workflow, or built-in relevance evaluation. The existing browser observations in [chat validation](chat-validation.md) are smoke checks, not an effectiveness benchmark.

[Documentation](README.md)
