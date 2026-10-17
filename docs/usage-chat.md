# RAGbox: Chatting with Documents

RAGbox supports keyword search with an optional local answer model. A collection must be ready before you can submit a message. See [installation](installation.md) for a first-time setup.

## Start with a collection

The start page places a search box and starter questions above **Collections in this browser**. Each collection card shows its readiness and available setup action:

- **NFCorpus:** click **Prepare NFCorpus** to import the prepared dataset and build its index.
- **MS MARCO:** click **Download MS MARCO index (3.35 GB)** and confirm the download.

Wait for the selected collection to become ready. A starter question submits immediately when its collection is ready; otherwise it fills the search box for later submission. After a chat starts, use the collection menu to change collections.

The first-visit tour highlights collections, the optional answer model, Settings, and the search box. **Skip tour**, **Esc**, or running a search ends it. **New here? Take the tour** replays it.

## Search without the answer model

Submit a query such as `breast cancer` in NFCorpus. Without a ready model, RAGbox performs keyword search using the literal message and shows up to ten retrieved documents in **Sources**.

This is useful for inspecting retrieval before installing the model. Contextual follow-ups require the model: a message such as `What did that study measure?` otherwise searches those literal words.

Click **Download model (~1.84 GB)** to enable answers on a supported GPU. If the latest active turn is awaiting an answer, model loading completes that turn. When context is needed, RAGbox first resolves the query and searches again. It does not generate answers for all older saved searches.

## Ask a question and a follow-up

With NFCorpus and the model ready, try:

1. Start a new chat and ask `Does vitamin D lower cancer risk?`.
2. Wait for the answer and open its **Sources**.
3. Read the cited articles and compare the claims with the text.
4. Ask `What did that study actually measure?`.
5. Inspect the follow-up's resolved search query and its newly retrieved sources.

The first message searches directly. Later messages are rewritten into standalone queries by the local model, then retrieve fresh evidence. Previous answers help interpret references; factual support must come from the current turn's retrieved documents. A failed rewrite exposes **Retry** rather than using a guessed query.

Answers vary across runs. A linked citation confirms that its ID belongs to the evidence supplied to the model; you still need to check whether the source supports the claim. Recorded limitations and earlier browser observations are in [chat validation](chat-validation.md).

## Read sources and citations

Expand **Sources** below a reply to see the resolved query, retrieved document IDs and titles, BM25 scores, and full document text. Each turn stores its own source snapshot, so a later query does not change the sources of an earlier answer.

Clicking a citation opens Sources and focuses the cited document. Only IDs from that turn's fitted model evidence become links. Unknown IDs remain text. The model may receive fewer than ten documents, or a truncated final document, because the prompt has a [token budget](local-model.md#context-and-output-limits).

With Low or Medium thinking effort, **Reasoning** stays folded by default and can be expanded during generation. The final answer is separate. The copy button copies only the final answer, and reasoning is excluded from follow-up history and citation linking.

If retrieval returns no documents, RAGbox gives an insufficient-evidence response without running answer generation. When retrieved documents are unrelated, the model is instructed to say so. The model can still misinterpret relevant material or abstain unnecessarily.

## Composer and reply controls

| Control | Behavior |
| --- | --- |
| **Enter** | Submit a message. |
| **Shift+Enter** | Insert a newline. |
| **Thinking effort** lightbulb | Choose Off, Low, or Medium for newly submitted messages. Off is the default. |
| **Stop** | Stop the active turn while retaining partial answer text, reasoning, sources, and valid citations. |
| **Retry** | Retry the latest failed or stopped turn without adding a duplicate message. |
| **New chat** or the RAGbox logo | Stop current work and open an empty chat in the selected collection. |
| **Settings** | Open collection, model, and storage controls while ongoing work continues. |

Messages are limited to 500 characters. Longer drafts show a length warning and disable Send until shortened. The draft remains editable while a reply is processing. See [the model guide](local-model.md#thinking-effort) for the cost and limits of reasoning.

Retries retain the submitted message's thinking effort. A generation retry reuses its captured question, history, and retrieval results; failed query-resolution or retrieval stages run again. Changing the effort preference during a reply applies to future submissions.

Scrolling stays near new text while you are near the bottom. If you scroll back to read an earlier reply, streaming preserves that position and does not move keyboard focus.

## Return to a conversation

Switching collections stops current work and restores the selected collection's active chat. Reloading restores saved conversations, including separate reasoning, answers, and source snapshots. An interrupted turn reopens as **Stopped** and requires an explicit retry.

The **History** page is currently disabled by `HISTORY_ENABLED` in [src/features.ts](../src/features.ts). Conversations are still saved for reloads and follow-ups. If a developer enables History, it provides full-text conversation filtering, **Continue chat**, and **Clear history**. Those controls are unavailable in the default build.

See [browser storage](storage.md) for retention, storage failures, and deletion behavior.

[Documentation](README.md)
