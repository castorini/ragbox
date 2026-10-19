# RAGbox Documentation

RAGbox runs document retrieval and optional answer generation in the browser. DuckDB-Wasm searches NFCorpus or MS MARCO with BM25, and a local MiniCPM model can turn the retrieved evidence into a streamed answer with citations.

## Getting started

Start with [installation](installation.md), prepare NFCorpus, and follow [chatting with documents](usage-chat.md). You can inspect search results before downloading the optional answer model.

| Guide | What you will learn |
| --- | --- |
| [Installation](installation.md) | Set up a checkout, obtain NFCorpus, and run the application locally. |
| [Chatting with documents](usage-chat.md) | Search, ask follow-up questions, inspect citations, stop a reply, and retry. |
| [Collections and retrieval](collections.md) | Prepare NFCorpus, download MS MARCO, understand BM25 results, and build a compatible MS MARCO database. |
| [Local answer model](local-model.md) | Install MiniCPM, understand how replies are generated, understand context limits, and recover cached files. |
| [Browser storage](storage.md) | Find out what is saved, how origins affect persistence, and what the deletion controls remove. |
| [Troubleshooting](troubleshooting.md) | Resolve setup, download, GPU, retrieval, and persistence problems. |

## Development and deployment

- [Development guide](development.md): commands, architecture, state and worker contracts, and validation.
- [Deployment guide](deployment.md): static builds, GitHub Pages, asset paths, and MS MARCO hosting configuration.
- [Chat implementation and validation](chat-validation.md): the existing regression checklist, recorded browser observations, and answer-quality limitations. Some observations describe earlier thinking controls or the currently disabled History page.
- [Experiment notes](experiments.md): the existing DuckDB OPFS experiments, native index construction, and scaling notes. This is a historical record; several controls described there have been removed from the application. Use the guides above for the current interface.

## Related Castorini projects

These guides follow the task-oriented documentation used across Castorini: a short project overview, installation instructions, runnable walkthroughs, and explicit validation notes. For background on the retrieval pipeline:

| Project | Related reading |
| --- | --- |
| [Anserini](https://github.com/castorini/anserini) | [Start Here](https://github.com/castorini/anserini/blob/master/docs/start-here.md) introduces queries, collections, relevance, and retrieval evaluation. |
| [Pyserini](https://github.com/castorini/pyserini) | [Searching with different retrieval models](https://github.com/castorini/pyserini/blob/master/docs/usage-search.md) explains first-stage retrieval using prebuilt indexes. |
| [RankLLM](https://github.com/castorini/rank_llm) | [Reranking with LLMs](https://github.com/castorini/rank_llm/blob/main/docs/onboarding.md) introduces the reranking stage of a multi-stage pipeline. |
| [QuackIR](https://github.com/castorini/quackir) | [NFCorpus with DuckDB](https://github.com/castorini/quackir/blob/main/docs/experiments-nfcorpus.md) walks through database-backed retrieval and evaluation on the same small collection. |

RAGbox currently uses DuckDB FTS for retrieval and MiniCPM for answer generation. It has no reranking stage. Anserini, Pyserini, RankLLM, and QuackIR provide useful context but are not required to run the application.

[Project README](../README.md)
