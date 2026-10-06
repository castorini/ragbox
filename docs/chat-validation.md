# Chat implementation and validation

The Search route now hosts a local conversational workspace. The implementation can be reviewed in four parts:

1. **Services and compatibility:** `collection-retrieval.ts` contains normalized, parameterized BM25 queries, including the old NFCorpus schema. `model-service.ts` owns model lifecycle and cancellable inference without DOM access. Existing collection and model controls remain adapters for Settings and compatibility tests.
2. **Conversation state and orchestration:** `types.ts`, `conversations.ts`, `chat-controller.ts`, `rag.ts`, and `llm-worker.ts` define snapshots, serialized persistence, stage-sensitive retries, request identities, follow-up resolution, and bounded context. `generation-output.ts` separates streamed reasoning from final text, and `generation-budget.ts` applies independent reasoning and final-output limits.
3. **Presentation:** `chat-view.ts`, `index.html`, collection navigation, and CSS provide chronological replies, folded reasoning, expandable sources, a fixed bottom composer, searchable history, and per-collection chats.
4. **Validation and documentation:** regression tests, supported-browser checks, README, and tour copy cover startup, recovery, persistence, and deployment paths.

## Automated checks

Run from the repository root:

```sh
npm test
npm run typecheck
npm run build -- --base=/ragbox/
```

The prompt, thinking-mode, query-normalization, and effort-control update passes **294 tests in 25 files**, all four TypeScript projects, and the production build with the `/ragbox/` base. The original 180-test coverage is retained, with conversation, service, worker, context, reasoning-parser, generation-budget, and shared-retrieval checks added.

The new checks cover:

- Direct first-message retrieval; pronoun follow-ups; topic changes; both collection formats; bound query parameters; saved-analyzer tokenization and stopword filtering before stemming; legacy NFCorpus schema; empty results; malformed query rewrites; history and input budgets.
- Stop during retrieval, resolution, generation, and model waiting; stale worker responses; worker failure; collection changes; New chat; recovery; retries using the same turn and generation snapshot.
- Thinking-template output with a prefilled opening tag; case-insensitive and repeated thinking markers; partial marker suffixes at every streaming boundary; interrupted reasoning; monotonic reasoning and final-answer channels; separate token limits for reasoning, answers, and rewritten queries; bounded finalization when the reasoning cap is reached.
- Stop during reasoning with an empty final answer; stale thinking events after cancellation and New chat; Retry clearing prior reasoning while retaining the same turn and source snapshot; reasoning excluded from final citations and follow-up history.
- Low (256), Balanced (1,024), and High (2,048) reasoning-token caps with the same separate 512-token final allowance; malformed effort values defaulting to Balanced; saved preferences and per-turn effort; changes during retrieval and retries retaining the submitted choice; model recovery retaining the pending turn's effort. Query rewriting keeps its separate fixed budget.
- Source snapshots and citation metadata surviving later questions and reload; distinct source anchors; unknown citation IDs remaining unlinked.
- Deterministic legacy imports and their marker; blocked legacy storage; interrupted turns; separate saved reasoning and answer fields; interrupted reasoning restoring as Stopped; compatibility with older saves; serialized writes; one-second streaming checkpoints; storage failures; deterministic ordering and retention of 50 nonempty chats; clearing history.
- Enter, Shift+Enter, and IME composition handling. Browser checks cover the actual focus and layout behavior.

Mocked workers establish lifecycle behavior, not model answer quality. The BM25 unit checks cover both collection adapters; they are not a full MS MARCO benchmark.

## Thinking-mode browser smoke test

On October 6, 2026, the thinking-effort control was checked in Chrome with the cached model under `/ragbox/`. High survived reload; changing the selector during a reply kept the reply running and the draft editable. At 390 × 844 the document width remained 390 and the composer bottom stayed at 844; the viewport override was reset. A Low-effort NFCorpus question about caffeine and blood pressure completed with 1,258 characters of folded reasoning and a separate cited final answer. Its MED-880 and MED-878 claims matched the saved studies, but it added an unnecessary sentence about intraocular pressure; effort controls do not eliminate the existing answer-quality limitations. A High-effort turn could be stopped after changing the preference, and Retry reused its single turn. The completed Low reply reopened from History with its reasoning still folded. Automated request and budget tests establish that in-flight turns and retries retain their captured cap; the browser observations are not a token-count or comparative-quality benchmark.

Chrome was exercised on October 5, 2026 (America/Toronto), with the real cached MiniCPM5-2B model and a prepared NFCorpus index. This run checked the improved prompt and enabled thinking mode.

| Check | Observed result |
| --- | --- |
| Reasoning presentation | Thinking started folded. Expanding it during streaming kept the section open as further text arrived. Reasoning stayed separate from the final-answer area. |
| Stop during reasoning | Stop retained 3,582 characters of reasoning with an empty final answer. Reload restored the turn as Stopped. Retry reset its reasoning while keeping the same turn and retrieved snapshot. |
| Final-only Copy | The clipboard matched the final answer and omitted reasoning. |
| Citation snapshots | Repeated MED-4570 citations had distinct turn-specific source anchors. |
| Focus and draft | Completion preserved composer focus and the unsent `Next draft` text. |
| Narrow layout | At 390 × 844, document scroll width was 390 and the composer bottom was 844, with both Thinking and Sources folded. The temporary viewport override was reset. |
| Production path | The `/ragbox/` production preview loaded saved reasoning, final answers, and the cached model worker. |
| MS MARCO startup | The currently cached index opened successfully with 8,841,823 passages, without a replacement download during this run. |
| MS MARCO keyword retrieval and inference | `capital france` retrieved Paris passages and produced a cited final answer. Its three citations matched their saved passage snapshots. Broader answer quality remains a separate check. |

## Thinking-mode actual-model observations

The shortened prompt changed the original vitamin D question from a literal canned refusal into a partial evidence summary. The answer cited MED-2762 for a review reporting no clear benefit and MED-4570 for a dosing and serum-level study. An uncited closing sentence led to an additional instruction requiring a citation on every factual sentence, including the final sentence.

The follow-up `What did that study actually measure?` resolved to `what did study measure vitamin D cancer prevention`. The answer identified the study's subject and measurements, but an additional toxicity sentence misread the source. This remains a semantic grounding error; successful query resolution and valid citation IDs do not establish that every claim matches the evidence. The latest prompt asks for one to three sentences, allows one sentence to suffice, and discourages padding with other findings. A comprehensive quality evaluation remains outstanding.

The MS MARCO query `What is the capital of France?` initially retrieved passages about OFS Capital and offing rather than Paris. The model abstained, including an invented `[NO-EXTRA]` marker that remained unlinked. The keyword query `capital france` instead retrieved Paris evidence and produced `Paris is the capital of France [MARCO-5219521] [MARCO-7568152] [MARCO-3962635].` Each citation was supported by that turn's saved passage snapshot. This verifies live keyword retrieval and inference on the valid cached index, not comprehensive answer quality.

The shared retrieval service now tokenizes each query with the saved FTS analyzer and filters its stopwords before stemming. It keeps the original user or resolved message in the conversation and requires no index rebuild. This addresses old query macros that could stem stopwords even though indexing had dropped them. Normalization runs in a separate small statement, then binds plain text to the original BM25 macro; embedding the normalization subquery in the full scan exhausted DuckDB-Wasm memory on the large index. The latest resolver prompt prefers concise search keywords, and the answer prompt requests an uncited refusal when all evidence is unrelated.

On October 6, 2026 (America/Toronto), the final two-statement operation was verified on the same cached 8,841,823-passage MS MARCO index under `/ragbox/`. The original full sentence `What is the capital of France?` retrieved Paris passages and produced a cited final answer with folded reasoning, without the memory error. Retrieval took about 17.5 seconds on this device; this is a smoke observation, not a performance benchmark. A fresh chat containing only `the of is` returned zero sources, no reasoning, and the insufficient-evidence response without invoking answer generation. The same empty-query check passed for NFCorpus, and `What does the evidence say about coffee?` successfully retrieved NFCorpus evidence in about 153 ms. These checks establish live query execution for both saved analyzers; they do not establish the accuracy of every model claim.

## Historical browser smoke test

Chrome was exercised on October 4, 2026 (America/Toronto), using a real prepared NFCorpus index and cached MiniCPM5-2B model at `http://127.0.0.1:5173/`. These observations predate the improved prompt and enabled thinking mode; they do not establish the quality of the updated generation behavior. Repeat the checks below with the current implementation.

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

## Historical actual-model observations

The initial follow-up prompt sometimes made the small model answer the question instead of producing a query. The final resolver quotes the conversation in one user message, explicitly requests a JSON query, uses deterministic decoding, and validates the output. A malformed result exposes Retry.

The real-model sequence below verified reference resolution and a fresh topic:

| Message | Resolved retrieval query / evidence check |
| --- | --- |
| What does the evidence say about coffee and sleep? | Searched the original message directly and generated a cited reply. |
| What does it do to blood pressure? | Resolved to `effect of coffee on blood pressure`. The acute caffeinated-coffee blood-pressure claim matched the results in MED-878; its citation opened that turn's own snapshot. |
| Now, what do the documents say about broccoli and cancer? | Resolved to `broccoli and cancer documents`, without carrying coffee into retrieval. The sulforaphane pathway claim matched MED-2232. |

These are smoke checks, not a comprehensive quality evaluation. Some sampled replies included unrelated findings, and a broad coffee summary attached a clause about adverse endothelial effects to sources that did not establish that clause. Grounding instructions and allowed-ID filtering cannot verify the meaning of every claim. The current 2B model should remain an experimental aid with inspectable evidence; answer quality is a known limitation.

The October 4 MS MARCO check was blocked by an invalid cached index; no replacement download was performed then. The October 5 run opened the currently cached valid index and verified keyword retrieval with live inference. The October 6 run verified the full-sentence normalization regression on that index. Broad MS MARCO answer quality remains pending. Both collection query paths and failure recovery are covered by tests.

## Repeatable manual checks

Use one tab per origin. Start with a prepared NFCorpus index and supported cached model, then:

1. Ask about coffee and follow with a pronoun question. Expand Sources and check the resolved query and cited text. Change to a distinct topic and confirm that its sources change.
2. Type the next draft during generation; visit Settings and History; return and confirm that the reply and draft survived. Scroll up during streaming and ensure the page stays put. Stay near the bottom for another reply and confirm automatic scrolling.
3. Confirm the Thinking section starts folded and that reasoning never appears in the final-answer area. Expand it during generation and confirm subsequent chunks preserve its open state, scroll position, and keyboard focus. Once the final answer arrives, use Copy and confirm the clipboard contains only that answer. Reasoning citation-like text must remain plain text.
4. Stop while reasoning is still streaming, before any final answer. The turn should retain its folded reasoning with an empty answer and no answer citations. Retry should clear the previous reasoning, reuse the retrieved snapshot, and update the same turn. When reasoning reaches its cap, confirm generation moves to bounded final output using the same assistant prefix. An empty answer or invalid final query should expose Retry without treating reasoning as a final answer or a search query.
5. Stop at each other visible stage, including model waiting. Retry the latest turn and confirm no duplicate message. Switch collections, start a new chat, and open another saved chat while work is active; late answer and thinking events must not affect the new view.
6. Reload during reasoning or answer generation and verify Stopped with explicit Retry. Reload a completed chat and inspect its saved folded reasoning and original citation links. Ask a follow-up and confirm only completed final replies provide assistant history. Try an unavailable model and confirm literal keyword results, then load it and confirm only the latest active unanswered turn finishes.
7. Ask about vitamin D and cancer. Inspect the actual fitted evidence and verify that the answer distinguishes background claims about cancer prevention from measured outcomes in MED-4570. Where relevant evidence supports only a partial answer, confirm that the model explains the limitation with citations instead of refusing broadly. This requires the actual model; prompt and parser tests cannot establish claim accuracy.
8. Confirm Clear history only on disposable test data. Verify empty Chat, then reload. Index/model deletion should retain conversations and readable source text. Use fault-injection tests for storage and stale-event failures instead of corrupting browser data.
9. With a valid MS MARCO index, compare `What is the capital of France?` and `capital france`. Confirm that stopwords do not cause unrelated OFS Capital or offing passages to dominate and that each cited answer is supported by its saved passages. Try a stopword-only message such as `the of is`; it should retrieve no matches and skip answer generation. Check that Sources still displays the original submitted or resolved query.
10. Exercise the same checks under `/ragbox/` and at a narrow viewport. A full MS MARCO browser check needs a valid downloaded index; keep its large download explicit.
