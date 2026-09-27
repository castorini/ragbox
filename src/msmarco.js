import { openPrebuilt, PREBUILT_NAME } from './prebuilt-msmarco.js';
import { downloadPrebuilt } from './download-prebuilt.js';

export function normalizeMSMarcoResults(rows) {
  return rows.map(row => ({
    id: `MARCO-${String(row.id)}`,
    title: `Passage ${String(row.id)}`,
    text: String(row.contents ?? ''),
  }));
}

export function setupMSMarco(run = task => task(), llm) {
  const status = document.querySelector('#marco-status');
  const output = document.querySelector('#marco-results');
  const fetchButton = document.querySelector('#marco-fetch');
  const reopenButton = document.querySelector('#marco-reopen');
  const searchButton = document.querySelector('#marco-search');
  const progress = document.querySelector('#marco-progress');
  const cancelDownload = document.querySelector('#marco-cancel-download');
  const downloadUrl = import.meta.env.VITE_MSMARCO_INDEX_URL ||
    'https://huggingface.co/datasets/DavidzzzZZZ/msmarco-duckdb-fts/resolve/d8b39bc9edc94a16fb77359243163ed80c609c84/msmarco-prebuilt.duckdb';
  const downloadBytes = 3346542592;
  let prebuilt;
  let busy = false;
  let blocked = false;
  let downloadController;
  const supported = window.isSecureContext && navigator.storage?.getDirectory;
  function updateButtons() {
    fetchButton.disabled = !supported || busy || blocked;
    reopenButton.disabled = !supported || busy || blocked;
    searchButton.disabled = !supported || busy || blocked || !prebuilt;
  }
  async function action(task) {
    if (busy || blocked || !supported) return;
    busy = true;
    updateButtons();
    try {
      return await run(async () => {
        try {
          return await task();
        } catch (error) {
          status.textContent = error.name === 'NotFoundError'
            ? 'No saved index found. Download the index first.'
            : `Unable to complete the request: ${error.message}`;
          console.error(error);
          throw error;
        }
      });
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
  async function connectPrebuilt() {
    prebuilt = await openPrebuilt();
    status.textContent = `Ready to search ${prebuilt.count.toLocaleString()} passages.`;
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
      downloadController = new AbortController();
      cancelDownload.hidden = false;
      cancelDownload.disabled = false;
      progress.hidden = false;
      progress.value = 0;
      let lastUpdate = 0;
      try {
        status.textContent = 'Starting index download…';
        await downloadPrebuilt({ url: downloadUrl, bytes: downloadBytes,
          root, name: PREBUILT_NAME, signal: downloadController.signal,
          onProgress(received, total) {
            const now = performance.now();
            if (now - lastUpdate < 200 && received !== total) return;
            lastUpdate = now;
            progress.value = received / total * 100;
            status.textContent = `Downloading index: ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB (${progress.value.toFixed(1)}%).`;
          },
        });
        cancelDownload.disabled = true;
        status.textContent = 'Download complete. Opening the saved index…';
        await connectPrebuilt();
      } catch (error) {
        if (error.name === 'AbortError') {
          status.textContent = 'Download cancelled. You can retry or reopen a previously saved index.';
          return;
        }
        throw error;
      } finally {
        cancelDownload.disabled = true;
        cancelDownload.hidden = true;
        progress.hidden = true;
        downloadController = undefined;
      }
    });
  };
  reopenButton.onclick = () => action(async () => {
    await closePrebuilt();
    output.replaceChildren();
    status.textContent = 'Opening the saved index…';
    await connectPrebuilt();
  });
  document.querySelector('#marco-form').onsubmit = event => {
    event.preventDefault();
    const query = document.querySelector('#marco-query').value.trim();
    if (!query) return;
    llm?.beginRetrieval('msmarco');
    if (!prebuilt) {
      status.textContent = 'Download or reopen the index before searching.';
      llm?.showRetrievalMessage('msmarco', 'Open the MS MARCO index before generating an answer.');
      return;
    }
    return action(async () => {
      output.replaceChildren();
      status.textContent = 'Searching…';
      const stmt = await prebuilt.conn.prepare(`SELECT id, contents,
        fts_main_msmarco.match_bm25(id, ?) AS score FROM msmarco
        WHERE score IS NOT NULL ORDER BY score DESC, id LIMIT 10`);
      let rows;
      try { rows = (await stmt.query(query)).toArray(); }
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
      status.textContent = rows.length
        ? `Showing ${rows.length} results for “${query}”.`
        : `No results for “${query}”. Try different search words.`;
      return rows;
    }).then(rows => {
      if (rows?.length) {
        const documents = normalizeMSMarcoResults(rows);
        llm?.generate({
          corpus: 'msmarco',
          question: query,
          documents,
          citationTargets: new Map(rows.map(row => [
            `MARCO-${String(row.id)}`,
            `#marco-result-${encodeURIComponent(String(row.id))}`,
          ])),
          evidenceLabel: 'passages',
        });
      } else if (rows) {
        llm?.showRetrievalMessage('msmarco', 'No retrieved passages support an answer for this query.');
      } else {
        llm?.showRetrievalMessage('msmarco', 'Retrieval failed, so answer generation was skipped.');
      }
      return rows;
    });
  };
  if (!supported) status.textContent = 'This app needs a browser with file storage support, such as desktop Chrome, on HTTPS or localhost.';
  updateButtons();
  return {
    setBlocked(value) { blocked = value; updateButtons(); },
    async close() {
      await closePrebuilt();
      output.replaceChildren();
      status.textContent = 'Index closed. Reload to reopen it.';
      updateButtons();
    },
  };
}
