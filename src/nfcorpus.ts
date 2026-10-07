import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { errorMessage, requiredElement, rowsAs } from './boundaries.ts';
import type { LLMController } from './llm-controller.ts';
import type { EvidenceDocument, RunTask } from './types.ts';
import { ResourceStates, type ResourcePhase } from './resource-state.ts';
import type { LoadCoordinator } from './load-coordinator.ts';
import type { SearchHistory } from './history.ts';
import { NFCORPUS_SEARCH_SQL, nfcorpusSearchSQL, queryBM25, retrieveNFCorpus } from './collection-retrieval.ts';

type SearchRow = EvidenceDocument & { score: number };
type SearchLLM = Pick<LLMController, 'beginRetrieval' | 'generate' | 'showRetrievalMessage'> & Partial<Pick<LLMController, 'isCurrentSearch'>>;
type History = Pick<SearchHistory, 'record' | 'attachAnswer'>;

// FTS executes through the same DuckDB-Wasm worker and persistent OPFS database.
export const SEARCH_SQL = NFCORPUS_SEARCH_SQL;
export const INDEX_SQL = `PRAGMA create_fts_index(
  'nfcorpus', 'id', 'contents', overwrite = 1
)`;

export function setupNFCorpus(db: Pick<AsyncDuckDB, 'registerFileText' | 'dropFile'>, conn: Pick<AsyncDuckDBConnection, 'query' | 'prepare'>, run: RunTask, llm: SearchLLM, onState?: (phase: ResourcePhase, message: string) => void, loads?: LoadCoordinator, history?: History, gate = new ResourceStates()) {
  const status = requiredElement<HTMLElement>('#fts-status');
  const searchStatus = document.querySelector<HTMLElement>('#fts-search-status');
  const answerPanel = document.querySelector<HTMLElement>('#fts-answer-panel');
  const results = document.querySelector<HTMLOListElement>('#fts-results');
  const setup = requiredElement<HTMLElement>('#fts-setup');
  const indexButton = requiredElement<HTMLButtonElement>('#fts-index');
  const searchButton = document.querySelector<HTMLButtonElement>('#fts-search');
  let ready = false;
  let searchSQL = SEARCH_SQL;
  let loaded = false;
  let queued = false;
  let checking = true;
  function report(phase: ResourcePhase, message: string) {
    status.textContent = message;
    status.closest?.('.settings-resource')?.setAttribute('data-phase', phase);
    onState?.(phase, message);
  }
  function updateControls() {
    setup.hidden = ready;
    indexButton.hidden = ready;
    indexButton.disabled = gate.busy || queued || checking;
    if (searchButton) searchButton.disabled = gate.busy || !ready;
  }
  async function readSchema() { searchSQL = await nfcorpusSearchSQL(conn); }
  async function loadExtension() {
    if (loaded) return;
    report('preparing', 'Preparing index…');
    await conn.query('INSTALL fts');
    await conn.query('LOAD fts');
    loaded = true;
  }
  const exists = async () => Number(rowsAs<{ n: number | bigint }>(await conn.query(`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_catalog = current_database()
      AND table_schema = 'main' AND table_name = 'nfcorpus'
  `))[0].n) > 0;

  async function action<T>(task: () => Promise<T>, searching = false): Promise<T | undefined> {
    return run(async () => {
      results?.replaceChildren();
      try { return await task(); }
      catch (error) {
        ready = false;
        indexButton.textContent = 'Retry setup';
        updateControls();
        report('error', `Could not open or search NFCorpus: ${errorMessage(error)}. Retry preparing NFCorpus.`);
        throw error;
      }
    }, searching ? 'nfcorpus' : undefined);
  }

  async function prepare() {
    if (queued || checking || gate.busy) return;
    queued = true;
    updateControls();
    report('preparing', 'Waiting to prepare index…');
    try {
      const prepare = () => action(async () => {
        ready = false;
        updateControls();
        llm.showRetrievalMessage('nfcorpus', '');
        await loadExtension();
        if (!await exists()) {
          report('preparing', 'Loading documents…');
          const response = await fetch(`${import.meta.env.BASE_URL}data/nfcorpus.jsonl`);
          if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
            throw new Error('Dataset missing. Run npm run prepare:nfcorpus -- /path/to/corpus.jsonl first.');
          }
          const contents = await response.text();
          const rows = contents.trim().split(/\r?\n/).map(line => JSON.parse(line) as { id: string });
          if (rows.length !== 3633 || new Set(rows.map(row => row.id)).size !== 3633) {
            throw new Error('Expected 3,633 unique NFCorpus documents.');
          }
          await db.registerFileText('nfcorpus-import.jsonl', contents);
          try {
            await conn.query(`CREATE TABLE nfcorpus AS
              SELECT id, title, text, title || ' ' || text AS contents
              FROM read_json_auto('nfcorpus-import.jsonl', format = 'newline_delimited')`);
          } finally {
            await db.dropFile('nfcorpus-import.jsonl');
          }
        }
        await readSchema();
        report('preparing', 'Building index…');
        await conn.query(INDEX_SQL);
        await conn.query('CHECKPOINT');
        const count = rowsAs<{ n: number | bigint }>(await conn.query('SELECT count(*) AS n FROM nfcorpus'))[0].n;
        ready = true;
        updateControls();
        report('ready', `Ready to search · ${count.toLocaleString()} documents.`);
      });
      return await (loads ? loads.run(prepare) : prepare());
    } finally {
      queued = false;
      updateControls();
    }
  }
  indexButton.onclick = () => prepare();

  const form = document.querySelector<HTMLFormElement>('#fts-form');
  if (form) form.onsubmit = event => {
    if (!results || !answerPanel || !searchStatus) return;
    event.preventDefault();
    if (!ready || gate.busy || queued || checking) return;
    const query = requiredElement<HTMLInputElement>('#fts-query').value.trim();
    if (!query) return;
    requiredElement<HTMLElement>('#fts-results-area').hidden = false;
    answerPanel.hidden = false;
    searchStatus.hidden = false;
    const searchToken = llm.beginRetrieval('nfcorpus');
    return action(async () => {
      await loadExtension();
      const index = await conn.query(`SELECT count(*) AS n FROM information_schema.schemata
        WHERE schema_name = 'fts_main_nfcorpus' AND catalog_name = current_database()`);
      if (!await exists() || Number(rowsAs<{ n: number | bigint }>(index)[0].n) === 0) {
        ready = false;
        updateControls();
        report('missing', 'Not prepared. Prepare NFCorpus to search.');
        return null;
      }
      await readSchema();
      searchStatus.textContent = 'Searching saved NFCorpus documents…';
      const start = performance.now();
      const rows = await queryBM25<SearchRow>(conn, searchSQL, query);
      if (llm.isCurrentSearch && !llm.isCurrentSearch(searchToken)) return;
      for (const row of rows) {
        const item = document.createElement('li');
        item.id = `fts-result-${encodeURIComponent(String(row.id))}`;
        item.tabIndex = -1;
        const title = document.createElement('h3');
        title.textContent = row.title;
        const metadata = document.createElement('p');
        metadata.textContent = `${row.id} · BM25 ${Number(row.score).toFixed(4)}`;
        const excerpt = document.createElement('p');
        excerpt.textContent = row.text.slice(0, 350) + (row.text.length > 350 ? '…' : '');
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Full document text';
        const full = document.createElement('p');
        full.textContent = row.text;
        details.append(summary, full);
        item.append(title, metadata, excerpt, details);
        results.append(item);
      }
      searchStatus.textContent = rows.length
        ? `Showing the top ${rows.length} matches for “${query}” (${(performance.now() - start).toFixed(0)} ms, including rendering).`
        : `No matches for “${query}”. Try different terms; common stopwords are excluded.`;
      onState?.('ready', 'NFCorpus is ready to search.');
      return rows;
    }, true).then(rows => {
      if (llm.isCurrentSearch && !llm.isCurrentSearch(searchToken)) return;
      const entry = rows && history?.record({
        corpus: 'nfcorpus',
        query,
        results: rows.map(row => ({ id: String(row.id), title: row.title, text: row.text, score: Number(row.score) })),
      });
      if (rows?.length) {
        llm.generate({
          corpus: 'nfcorpus',
          question: query,
          searchToken,
          documents: rows,
          citationTargets: new Map(rows.map(row => [
            String(row.id),
            `#fts-result-${encodeURIComponent(String(row.id))}`,
          ])),
          evidenceLabel: 'documents',
          onStopped: entry ? (answer, cited) => history?.attachAnswer(entry.id, answer, cited, 'stopped') : undefined,
          onComplete: entry ? (answer, cited) => history?.attachAnswer(entry.id, answer, cited) : undefined,
        });
      } else if (rows) {
        llm.showRetrievalMessage(
          'nfcorpus',
          'No retrieved documents support an answer for this query.',
        );
      } else if (rows === null) {
        llm.showRetrievalMessage('nfcorpus', 'Build the NFCorpus index before generating an answer.');
      } else {
        llm.showRetrievalMessage('nfcorpus', 'Retrieval failed, so answer generation was skipped.');
      }
    });
  };
  const unsubscribe = gate.watch(state => state.busy, updateControls);
  onState?.('checking', 'Checking saved index…');
  return {
    prepare,
    async retrieve(query: string) {
      if (!ready || gate.busy || queued || checking) throw new Error('NFCorpus is not ready to search.');
      const result = await action(() => retrieveNFCorpus(conn, query), true);
      if (!result) throw new Error('NFCorpus search could not run.');
      return result;
    },
    setBlocked(value: boolean) { gate.setBusy(value); },
    dispose: unsubscribe,
    async reopenSaved() {
      checking = true;
      updateControls();
      report('checking', 'Checking saved index…');
      try {
        return await action(async () => {
          const indexed = Number(rowsAs<{ n: number | bigint }>(await conn.query(`SELECT count(*) AS n FROM information_schema.schemata
            WHERE catalog_name=current_database() AND schema_name='fts_main_nfcorpus'`))[0].n) > 0;
          if (indexed && await exists()) {
            await loadExtension();
            await readSchema();
            // Bind the actual search before marking a persisted index as usable.
            const statement = await conn.prepare(searchSQL);
            await statement.close();
            ready = true;
            report('ready', 'Ready to search.');
          } else {
            ready = false;
            report('missing', 'Not prepared.');
          }
          updateControls();
        });
      } finally {
        checking = false;
        updateControls();
      }
    },
  };
}
