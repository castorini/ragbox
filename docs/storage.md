# RAGbox: Browser Storage

RAGbox keeps collection indexes, model files, and conversations in the browser. This guide explains their lifetime and the Settings controls that manage them.

## Storage locations

| Data | Location | Saved content |
| --- | --- | --- |
| NFCorpus | OPFS `analytics.duckdb` and its WAL/helper files | Document table and FTS index. |
| MS MARCO | OPFS `msmarco-prebuilt.duckdb` | Downloaded document table and FTS index, opened read-only. |
| Answer model | Browser Cache Storage | Pinned MiniCPM configuration, tokenizer, ONNX model, and weight files. |
| Conversations | IndexedDB database `ragbox-conversations`, version 1 | Turns, answers, reasoning, retrieved source snapshots, citation metadata, and navigation preferences. |
| Legacy history and interface preferences | localStorage | Earlier search history awaiting migration and small interface preferences such as tour state. |

OPFS files are private browser-managed files. They do not appear in the Downloads folder or in the repository. `public/data/nfcorpus.jsonl` is a separate static input file used to prepare the browser database.

## Use the same origin

Browser storage belongs to an origin: the combination of scheme, host, and port. It also belongs to a browser profile.

- `http://127.0.0.1:5173/` and `http://localhost:5173/` have separate storage.
- A development server on port `5173` and a preview server on port `4173` have separate storage.
- A published HTTPS site has separate storage from local development.
- URL paths on the same origin do not provide separate storage namespaces. Hosting multiple RAGbox copies under different paths on one origin can make them share the same database names and cache.

Keep one RAGbox tab open per origin because the DuckDB OPFS handles are exclusive. Close other instances before reopening or deleting databases.

Saved data can be cleared or evicted by the browser. Private browsing and restrictive storage settings can also prevent durable storage. Conversations and cached assets are not an independent backup.

## Conversation persistence

Submitted turns, retrieval snapshots, settled answers, reasoning, and valid citation metadata are saved asynchronously. Streaming text is checkpointed at most once per second. Writes are serialized so a delayed earlier save cannot overwrite a later answer. The newest 50 nonempty conversations are retained and titled from their first question.

Reload restores the selected collection and its active chat. In-progress turns become **Stopped** and require an explicit Retry; saved transcripts never restart inference automatically. Drafts and transient operation identities are not persisted. If storage fails, the current chat remains usable in memory and the interface displays an unsaved notice.

Earlier `ragbox-search-history` localStorage entries import as one-turn conversations with deterministic IDs. The migration preserves timestamps, retrieved sources, answers, and stopped status. An import marker commits with the conversations to prevent duplicates. Original legacy data remains until **Clear history**.

The History page is currently disabled by [src/features.ts](../src/features.ts). Saving, reload restoration, retention, and follow-up context still work. Enabling History adds conversation filtering, **Continue chat**, and **Clear history**.

## Inspect saved files

Open Settings to see separate sections for collections and the answer model. **Advanced file management** exposes OPFS file listings, model-cache listings, refresh controls, individual owned-file deletion, and MS MARCO replacement.

Some cached responses do not advertise a content length. Model storage totals can therefore be reported as a lower bound with some file sizes unknown. The application does not load weight bodies just to compute their sizes.

File listings can include files that RAGbox does not own. Deletion is limited to the allowlist in [src/reset.ts](../src/reset.ts), including the collection databases and legacy demo Parquet paths. Model deletion matches files belonging to the configured MiniCPM model rather than clearing unrelated browser caches.

## Remove saved data

| Action | Removed | Retained |
| --- | --- | --- |
| **Delete index data** | Both collection databases, their owned helper files, and legacy demo Parquet files. | Model cache, conversations, and source snapshots. |
| **Delete model** | Cached MiniCPM model files. | Collection indexes, conversations, and source snapshots. |
| **Delete indexes and model** | The index-data set and model files above. | Conversations and source snapshots. |
| Individual OPFS file deletion | The selected owned file; deleting either collection database also removes its owned WAL/helper files. | Other files, model cache, and conversations. |
| **Clear history**, when History is enabled | Saved conversations and legacy search history. | Collection indexes and model files. |

Resource deletion requires confirmation, closes the appropriate runtimes, and reloads the page. Controls are disabled during active resource work. If shutdown or deletion fails, **Reload to recover** appears. Close other RAGbox tabs before retrying.

Deleting an index or model leaves stored conversations and their source text readable. New retrieval requires a ready collection; new answers also require a ready model. **Clear history** stops active work and starts an empty chat. It is unavailable while History is disabled.

The application's deletion controls do not remove downloaded files on your computer or generated files in the checkout. Browser-level clearing of all site data is broader than these controls and can remove conversations and preferences too.

[Documentation](README.md)
