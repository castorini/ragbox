# Chat implementation and validation

The Search route now hosts a local conversational workspace. The implementation can be reviewed in four parts:

1. **Services and compatibility:** `collection-retrieval.ts` contains normalized, parameterized BM25 queries, including the old NFCorpus schema. `model-service.ts` owns model lifecycle and cancellable inference without DOM access. Existing collection and model controls remain adapters for Settings and compatibility tests.
2. **Conversation state and orchestration:** `types.ts`, `conversations.ts`, `chat-controller.ts`, `rag.ts`, and `llm-worker.ts` define snapshots, serialized persistence, stage-sensitive retries, request identities, follow-up resolution, and bounded context.
3. **Presentation:** `chat-view.ts`, `index.html`, collection navigation, and CSS provide chronological replies, expandable sources, a fixed bottom composer, searchable history, and per-collection chats.
4. **Validation and documentation:** regression tests, supported-browser checks, README, and tour copy cover startup, recovery, persistence, and deployment paths.

## Automated checks

Run from the repository root:

```sh
npm test
npm run typecheck
npm run build -- --base=/ragbox/
```

The final implementation passes **224 tests in 23 files**, the four TypeScript projects, and the production build with the `/ragbox/` base. The original 180-test coverage is retained, with conversation, service, worker, and context checks added.

The new checks cover:

- Direct first-message retrieval; pronoun follow-ups; topic changes; both collection formats; bound query parameters; legacy NFCorpus schema; empty results; malformed query rewrites; history and input budgets.
- Stop during retrieval, resolution, generation, and model waiting; stale worker responses; worker failure; collection changes; New chat; recovery; retries using the same turn and generation snapshot.
- Source snapshots and citation metadata surviving later questions and reload; distinct source anchors; unknown citation IDs remaining unlinked.
- Deterministic legacy imports and their marker; blocked legacy storage; interrupted turns; serialized writes; one-second streaming checkpoints; storage failures; deterministic ordering and retention of 50 nonempty chats; clearing history.
- Enter, Shift+Enter, and IME composition handling. Browser checks cover the actual focus and layout behavior.

Mocked workers establish lifecycle behavior, not model answer quality. The BM25 unit checks cover both collection adapters; they are not a full MS MARCO benchmark.

## Browser smoke test

Chrome was exercised on October 4, 2026 (America/Toronto), using a real prepared NFCorpus index and cached MiniCPM5-2B model at `http://127.0.0.1:5173/`.

| Check | Observed result |
| --- | --- |
| Cached startup | Saved NFCorpus reopened and cached model initialized without a model download. |
| Saved conversation | Completed and stopped replies reopened with source snapshots and citation links. Reload did not restart stopped work. |
| Keyboard and draft | Enter sent; Shift+Enter inserted a newline; the 500-character composer stayed editable during inference. |
| Navigation | Settings and History kept the active generation running. Returning to Chat preserved the draft and composer focus. |
| Stop | The current operation settled as Stopped, retaining text and fitted citation links. Retry remained on the latest turn. |
| Citation inspection | Clicking a citation expanded that reply's Sources, focused its document, and exposed full text. |
| Responsive layout | At 390 × 844, no horizontal overflow remained and the composer stayed at the viewport bottom. The temporary viewport override was reset. |
| History | Search filtered conversation cards; Continue chat restored the selected conversation and collection. |
| MS MARCO recovery | The existing cached file was not a valid DuckDB database. Selection exposed opening failure and recovery without downloading or replacing it. |

A separate production preview at `http://127.0.0.1:5174/ragbox/` verified script and worker loading, NFCorpus dataset preparation, starter questions, Settings links, literal keyword search without a model, empty retrieval, history filtering, and the clear-history confirmation. The preview used a separate storage origin. The clear action emptied its test history; its final presentation now returns to the empty Chat workspace.

The fixed bottom composer required a more specific CSS selector because an older `#collections form` rule overrode its positioning. Source rows remain stable during streaming; pending scrolling checks both conversation identity and the user's current position before moving the page.

## Actual model observations

The initial follow-up prompt sometimes made the small model answer the question instead of producing a query. The final resolver quotes the conversation in one user message, explicitly requests a JSON query, uses deterministic decoding, and validates the output. A malformed result exposes Retry.

The real-model sequence below verified reference resolution and a fresh topic:

| Message | Resolved retrieval query / evidence check |
| --- | --- |
| What does the evidence say about coffee and sleep? | Searched the original message directly and generated a cited reply. |
| What does it do to blood pressure? | Resolved to `effect of coffee on blood pressure`. The acute caffeinated-coffee blood-pressure claim matched the results in MED-878; its citation opened that turn's own snapshot. |
| Now, what do the documents say about broccoli and cancer? | Resolved to `broccoli and cancer documents`, without carrying coffee into retrieval. The sulforaphane pathway claim matched MED-2232. |

These are smoke checks, not a comprehensive quality evaluation. Some sampled replies included unrelated findings, and a broad coffee summary attached a clause about adverse endothelial effects to sources that did not establish that clause. Grounding instructions and allowed-ID filtering cannot verify the meaning of every claim. The current 2B model should remain an experimental aid with inspectable evidence; answer quality is a known limitation.

Live inference and full-scale retrieval against a valid 3.35 GB MS MARCO index remain unverified in this environment because the existing cached file is invalid. No replacement download was performed. Both collection query paths and failure recovery are covered by tests.

## Repeatable manual checks

Use one tab per origin. Start with a prepared NFCorpus index and supported cached model, then:

1. Ask about coffee and follow with a pronoun question. Expand Sources and check the resolved query and cited text. Change to a distinct topic and confirm that its sources change.
2. Type the next draft during generation; visit Settings and History; return and confirm that the reply and draft survived. Scroll up during streaming and ensure the page stays put. Stay near the bottom for another reply and confirm automatic scrolling.
3. Stop at each visible stage, including model waiting. Retry the latest turn and confirm no duplicate message. Switch collections, start a new chat, and open another saved chat while work is active; late events must not affect the new view.
4. Reload during generation and verify Stopped with explicit Retry. Reload a completed chat and inspect its original citation links. Try an unavailable model and confirm literal keyword results, then load it and confirm only the latest active unanswered turn finishes.
5. Confirm Clear history only on disposable test data. Verify empty Chat, then reload. Index/model deletion should retain conversations and readable source text. Use fault-injection tests for storage and stale-event failures instead of corrupting browser data.
6. Exercise the same checks under `/ragbox/` and at a narrow viewport. A full MS MARCO browser check needs a valid downloaded index; keep its large download explicit.
