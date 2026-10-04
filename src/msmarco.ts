import { openPrebuilt, PREBUILT_NAME } from './prebuilt-msmarco.ts';
import { downloadPrebuilt } from './download-prebuilt.ts';
import { errorMessage, errorName, requiredElement, rowsAs } from './boundaries.ts';
import type { LLMController } from './llm-controller.ts';
import type { EvidenceDocument, RunTask } from './types.ts';
import type { ResourcePhase } from './resource-state.ts';
import type { LoadCoordinator } from './load-coordinator.ts';
import type { SearchHistory } from './history.ts';

type MarcoRow = { id: string | number | bigint; contents: string; score: number };
type SearchLLM = Pick<LLMController, 'beginRetrieval' | 'generate' | 'showRetrievalMessage'>;
type History = Pick<SearchHistory, 'record' | 'attachAnswer'>;

export function normalizeMSMarcoResults<T extends { id: string | number | bigint; contents?: string | null }>(rows: T[]): EvidenceDocument[] {
  return rows.map(row => ({
    id: `MARCO-${String(row.id)}`,
    title: `Passage ${String(row.id)}`,
    text: String(row.contents ?? ''),
  }));
}

export function setupMSMarco(run: RunTask = task => task(), llm?: SearchLLM, onState?: (phase: ResourcePhase, message: string) => void, loads?: LoadCoordinator, history?: History) {
  const status = requiredElement<HTMLElement>('#marco-status');
  const searchStatus = requiredElement<HTMLElement>('#marco-search-status');
  const answerPanel = requiredElement<HTMLElement>('#marco-answer-panel');
  const output = requiredElement<HTMLOListElement>('#marco-results');
  const fetchButton = requiredElement<HTMLButtonElement>('#marco-fetch');
  const reopenButton = requiredElement<HTMLButtonElement>('#marco-reopen');
  const searchButton = requiredElement<HTMLButtonElement>('#marco-search');
  const progress = requiredElement<HTMLProgressElement>('#marco-progress');
  const cancelDownload = requiredElement<HTMLButtonElement>('#marco-cancel-download');
  const setup = requiredElement<HTMLElement>('#marco-setup');
  const downloadUrl = import.meta.env.VITE_MSMARCO_INDEX_URL ||
    'https://huggingface.co/datasets/DavidzzzZZZ/msmarco-duckdb-fts/resolve/d8b39bc9edc94a16fb77359243163ed80c609c84/msmarco-prebuilt.duckdb';
  const downloadBytes = 3346542592;
  let prebuilt: Awaited<ReturnType<typeof openPrebuilt>> | undefined;
  let busy = false;
  let blocked = false;
  let checkingSaved = true;
  let retryOpen = false;
  let hasSaved = false;
  let openingQueued = false;
  let checkingPromise: Promise<void> | undefined;
  const unblockWaiters = new Set<() => void>();
  let downloadController: AbortController | undefined;
  const supported = Boolean(window.isSecureContext && navigator.storage?.getDirectory);
  function report(phase: ResourcePhase, message: string) {
    status.textContent = message;
    onState?.(phase, message);
  }
  function updateButtons() {
    setup.hidden = !!prebuilt || checkingSaved || !supported;
    fetchButton.hidden = checkingSaved || !!prebuilt || busy || openingQueued;
    reopenButton.hidden = checkingSaved || !!prebuilt || busy || openingQueued || !(hasSaved || retryOpen);
    reopenButton.textContent = retryOpen ? 'Retry opening index' : 'Open saved index';
    fetchButton.disabled = !supported || busy || blocked || openingQueued;
    reopenButton.disabled = !supported || busy || blocked || openingQueued;
    searchButton.disabled = !supported || busy || blocked || openingQueued || !prebuilt;
  }
  async function action<T>(task: () => Promise<T>, lockDatabase = true, searching = false): Promise<T | undefined> {
    if (busy || blocked || !supported) return;
    busy = true;
    updateButtons();
    try {
      const execute = async () => {
        try {
          return await task();
        } catch (error) {
          if (!prebuilt) {
            checkingSaved = false;
            retryOpen = errorName(error) !== 'NotFoundError';
            if (errorName(error) === 'NotFoundError') hasSaved = false;
            report(errorName(error) === 'NotFoundError' ? 'missing' : 'error',
              errorName(error) === 'NotFoundError'
                ? 'No saved index. Download the index first.'
                : `Unable to complete the request: ${errorMessage(error)}`);
          } else {
            searchStatus.hidden = false;
            searchStatus.textContent = `Search failed: ${errorMessage(error)}`;
          }
          console.error(error);
          throw error;
        }
      };
      return await (lockDatabase ? run(execute, searching ? 'msmarco' : undefined) : execute());
    } catch {
      return undefined;
    } finally {
      busy = false;
      updateButtons();
    }
  }
  async function closePrebuilt() {
    llm?.showRetrievalMessage('msmarco', '');
    const previous = prebuilt;
    prebuilt = undefined;
    if (previous) await previous.close();
  }
  async function connectPrebuilt(coordinated = false) {
    prebuilt = await (coordinated && loads ? loads.run(openPrebuilt) : openPrebuilt());
    checkingSaved = false;
    retryOpen = false;
    hasSaved = true;
    report('ready', `Ready to search ${prebuilt.count.toLocaleString()} passages.`);
  }
  cancelDownload.onclick = () => downloadController?.abort();
  fetchButton.onclick = () => {
    if (busy || blocked) return;
    if (!confirm('Download 3.35 GB into this browser’s storage? This replaces any saved MS MARCO index. Close other search tabs first.')) return;
    return action(async () => {
      await closePrebuilt();
      output.replaceChildren();
      const root = await navigator.storage.getDirectory();
      const estimate = await navigator.storage.estimate();
      if (estimate.quota != null && estimate.usage != null && estimate.quota - estimate.usage < downloadBytes) {
        throw new Error('Not enough available browser storage for this download.');
      }
      const controller = new AbortController();
      downloadController = controller;
      cancelDownload.hidden = false;
      cancelDownload.disabled = false;
      progress.hidden = false;
      progress.value = 0;
      let lastUpdate = 0;
      try {
        report('downloading', 'Starting index download…');
        await downloadPrebuilt({ url: downloadUrl, bytes: downloadBytes,
          root, name: PREBUILT_NAME, signal: controller.signal,
          onProgress(received, total) {
            const now = performance.now();
            if (now - lastUpdate < 200 && received !== total) return;
            lastUpdate = now;
            progress.value = received / total * 100;
            report('downloading', `Downloading index: ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB (${progress.value.toFixed(1)}%).`);
          },
        });
        cancelDownload.disabled = true;
        report('opening', 'Opening saved index…');
        await connectPrebuilt(true);
      } catch (error) {
        if (errorName(error) === 'AbortError') {
          report(hasSaved ? 'saved' : 'missing', hasSaved ? 'Download cancelled. Retry or open the saved index.' : 'Download cancelled. Retry downloading the index.');
          return;
        }
        throw error;
      } finally {
        cancelDownload.disabled = true;
        cancelDownload.hidden = true;
        progress.hidden = true;
        downloadController = undefined;
      }
    }, false);
  };
  async function openSaved() {
    if (openingQueued || busy || !supported) return;
    openingQueued = true;
    report('opening', 'Opening saved index…');
    updateButtons();
    try {
      const open = async () => {
        while (blocked) await new Promise<void>(resolve => unblockWaiters.add(resolve));
        return action(async () => {
          await closePrebuilt();
          output.replaceChildren();
          await connectPrebuilt();
        });
      };
      return await (loads ? loads.run(open) : open());
    } finally {
      openingQueued = false;
      updateButtons();
    }
  }
  reopenButton.onclick = () => openSaved();
  requiredElement<HTMLFormElement>('#marco-form').onsubmit = event => {
    event.preventDefault();
    const query = requiredElement<HTMLInputElement>('#marco-query').value.trim();
    if (!query) return;
    requiredElement<HTMLElement>('#marco-results-area').hidden = false;
    answerPanel.hidden = false;
    searchStatus.hidden = false;
    llm?.beginRetrieval('msmarco');
    const activePrebuilt = prebuilt;
    if (!activePrebuilt) {
      report('missing', 'Download or open the index to search.');
      llm?.showRetrievalMessage('msmarco', 'Open the MS MARCO index before generating an answer.');
      return;
    }
    return action(async () => {
      output.replaceChildren();
      searchStatus.textContent = 'Searching…';
      const stmt = await activePrebuilt.conn.prepare(`SELECT id, contents,
        fts_main_msmarco.match_bm25(id, ?) AS score FROM msmarco
        WHERE score IS NOT NULL ORDER BY score DESC, id LIMIT 10`);
      let rows;
      try { rows = rowsAs<MarcoRow>(await stmt.query(query)); }
      finally { await stmt.close(); }
      for (const row of rows) {
        const item = document.createElement('li');
        item.id = `marco-result-${encodeURIComponent(String(row.id))}`;
        item.tabIndex = -1;
        const heading = document.createElement('strong');
        heading.textContent = `Passage ${row.id}`;
        const text = document.createElement('p');
        text.textContent = row.contents;
        item.append(heading, text);
        output.append(item);
      }
      searchStatus.textContent = rows.length
        ? `Showing ${rows.length} results for “${query}”.`
        : `No results for “${query}”. Try different search words.`;
      return rows;
    }, true, true).then(rows => {
      const documents = rows ? normalizeMSMarcoResults(rows) : [];
      const entry = rows && history?.record({
        corpus: 'msmarco',
        query,
        results: documents.map((document, index) => ({ ...document, score: Number(rows[index].score) })),
      });
      if (rows?.length) {
        llm?.generate({
          corpus: 'msmarco',
          question: query,
          documents,
          citationTargets: new Map(rows.map(row => [
            `MARCO-${String(row.id)}`,
            `#marco-result-${encodeURIComponent(String(row.id))}`,
          ])),
          evidenceLabel: 'passages',
          onComplete: entry ? (answer, cited) => history?.attachAnswer(entry.id, answer, cited) : undefined,
        });
      } else if (rows) {
        llm?.showRetrievalMessage('msmarco', 'No retrieved passages support an answer for this query.');
      } else {
        llm?.showRetrievalMessage('msmarco', 'Retrieval failed, so answer generation was skipped.');
      }
      return rows;
    });
  };
  if (!supported) report('unsupported', 'File storage unavailable. Use desktop Chrome on HTTPS or localhost.');
  else onState?.('checking', 'Checking saved index…');
  updateButtons();
  async function checkSaved() {
    if (!supported || prebuilt) return;
    if (checkingPromise) return checkingPromise;
    checkingPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(PREBUILT_NAME);
        hasSaved = true;
        retryOpen = false;
        report('saved', 'Saved index available.');
      } catch (error) {
        hasSaved = false;
        retryOpen = errorName(error) !== 'NotFoundError';
        report(errorName(error) === 'NotFoundError' ? 'missing' : 'error',
          errorName(error) === 'NotFoundError'
            ? 'Not downloaded.'
            : `Could not check saved index: ${errorMessage(error)}. Retry opening the index.`);
      } finally {
        checkingSaved = false;
        updateButtons();
      }
    })();
    try { await checkingPromise; } finally { checkingPromise = undefined; }
  }
  return {
    checkSaved,
    async reopenSaved() {
      if (!supported) return;
      if (checkingSaved) await checkSaved();
      if (!hasSaved || prebuilt) return;
      await openSaved();
    },
    setBlocked(value: boolean) {
      blocked = value;
      updateButtons();
      if (!value) {
        for (const resolve of unblockWaiters) resolve();
        unblockWaiters.clear();
      }
    },
    async close() {
      await closePrebuilt();
      output.replaceChildren();
      report('saved', 'Saved index available.');
      updateButtons();
    },
  };
}
