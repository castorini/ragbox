import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { errorMessage, requiredElement, rowsAs } from './boundaries.ts';
import type { LLMController } from './llm-controller.ts';
import type { EvidenceDocument, RunTask } from './types.ts';
import type { ResourcePhase } from './resource-state.ts';
import type { LoadCoordinator } from './load-coordinator.ts';

type SearchRow = EvidenceDocument & { score: number };
type SearchLLM = Pick<LLMController, 'beginRetrieval' | 'generate' | 'showRetrievalMessage'>;

// FTS executes through the same DuckDB-Wasm worker and persistent OPFS database.
export const SEARCH_SQL = `
  SELECT id, title, text,
         fts_main_nfcorpus.match_bm25(id, ?) AS score
  FROM nfcorpus
  WHERE score IS NOT NULL
  ORDER BY score DESC, id
  LIMIT 10
`;
export const INDEX_SQL = `PRAGMA create_fts_index(
  'nfcorpus', 'id', 'contents', overwrite = 1
)`;

export function setupNFCorpus(db: Pick<AsyncDuckDB, 'registerFileText' | 'dropFile'>, conn: Pick<AsyncDuckDBConnection, 'query' | 'prepare'>, run: RunTask, llm: SearchLLM, onState?: (phase: ResourcePhase, message: string) => void, loads?: LoadCoordinator) {
  const status = requiredElement<HTMLElement>('#fts-status');
  const searchStatus = requiredElement<HTMLElement>('#fts-search-status');
  const answerPanel = requiredElement<HTMLElement>('#fts-answer-panel');
  const results = requiredElement<HTMLOListElement>('#fts-results');
  const setup = requiredElement<HTMLElement>('#fts-setup');
  const indexButton = requiredElement<HTMLButtonElement>('#fts-index');
  const searchButton = requiredElement<HTMLButtonElement>('#fts-search');
  let ready = false;
  let blocked = false;
  let searchSQL = SEARCH_SQL;
  let loaded = false;
  let queued = false;
  let checking = true;
  function report(phase: ResourcePhase, message: string) {
    status.textContent = message;
    onState?.(phase, message);
  }
  function updateControls() {
    setup.hidden = ready;
    indexButton.hidden = ready;
    indexButton.disabled = blocked || queued || checking;
    searchButton.disabled = blocked || !ready;
  }
  async function readSchema() {
    const columns = new Set(rowsAs<{ column_name: string }>(await conn.query(`SELECT column_name FROM information_schema.columns
      WHERE table_catalog = current_database() AND table_schema = 'main'
        AND table_name = 'nfcorpus'`)).map(row => row.column_name));
    if (!columns.has('id') || !columns.has('contents')) {
      throw new Error('The saved NFCorpus table is incompatible: document IDs and contents are required.');
    }
    // Older saved collections contain only IDs and combined document contents.
    const title = columns.has('title') ? 'title' : "'Document ' || CAST(id AS VARCHAR) AS title";
    const text = columns.has('text') ? 'text' : 'contents AS text';
    searchSQL = SEARCH_SQL.replace('SELECT id, title, text,', `SELECT id, ${title}, ${text},`);
  }
  async function loadExtension() {
    if (loaded) return;
    report('preparing', 'Loading the DuckDB FTS extension…');
    await conn.query('INSTALL fts');
    await conn.query('LOAD fts');
    loaded = true;
  }
  const exists = async () => Number(rowsAs<{ n: number | bigint }>(await conn.query(`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_catalog = current_database()
      AND table_schema = 'main' AND table_name = 'nfcorpus'
  `))[0].n) > 0;

  async function action<T>(task: () => Promise<T>): Promise<T | undefined> {
    return run(async () => {
      results.replaceChildren();
      try { return await task(); }
      catch (error) {
        ready = false;
        indexButton.textContent = 'Retry preparing NFCorpus';
        updateControls();
        report('error', `NFCorpus could not be opened or searched. ${errorMessage(error)} Use “Retry preparing NFCorpus” to try again.`);
        throw error;
      }
    });
  }

  indexButton.onclick = async () => {
    if (queued || checking || blocked) return;
    queued = true;
    updateControls();
    report('preparing', 'Waiting to prepare NFCorpus…');
    try {
      const prepare = () => action(async () => {
        ready = false;
        updateControls();
        llm.showRetrievalMessage('nfcorpus', '');
        await loadExtension();
        if (!await exists()) {
          report('preparing', 'Loading NFCorpus documents…');
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
        report('preparing', 'Building the full-text index in your browser…');
        const start = performance.now();
        await conn.query(INDEX_SQL);
        await conn.query('CHECKPOINT');
        const count = rowsAs<{ n: number | bigint }>(await conn.query('SELECT count(*) AS n FROM nfcorpus'))[0].n;
        const version = rowsAs<{ version: string }>(await conn.query('SELECT version() AS version'))[0].version;
        ready = true;
        updateControls();
        report('ready', `${count} documents indexed in ${((performance.now() - start) / 1000).toFixed(2)} s. ${version}. Ready to search.`);
      });
      return await (loads ? loads.run(prepare) : prepare());
    } finally {
      queued = false;
      updateControls();
    }
  };

  requiredElement<HTMLFormElement>('#fts-form').onsubmit = event => {
    event.preventDefault();
    const query = requiredElement<HTMLInputElement>('#fts-query').value.trim();
    if (!query) return;
    answerPanel.hidden = false;
    searchStatus.hidden = false;
    llm.beginRetrieval('nfcorpus');
    return action(async () => {
      await loadExtension();
      const index = await conn.query(`SELECT count(*) AS n FROM information_schema.schemata
        WHERE schema_name = 'fts_main_nfcorpus' AND catalog_name = current_database()`);
      if (!await exists() || Number(rowsAs<{ n: number | bigint }>(index)[0].n) === 0) {
        ready = false;
        updateControls();
        report('missing', 'Prepare NFCorpus in Setup before searching.');
        return null;
      }
      await readSchema();
      searchStatus.textContent = 'Searching saved NFCorpus documents…';
      const start = performance.now();
      const statement = await conn.prepare(searchSQL);
      let rows;
      try { rows = rowsAs<SearchRow>(await statement.query(query)); }
      finally { await statement.close(); }
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
    }).then(rows => {
      if (rows?.length) {
        llm.generate({
          corpus: 'nfcorpus',
          question: query,
          documents: rows,
          citationTargets: new Map(rows.map(row => [
            String(row.id),
            `#fts-result-${encodeURIComponent(String(row.id))}`,
          ])),
          evidenceLabel: 'documents',
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
  updateControls();
  onState?.('checking', 'Checking for a saved NFCorpus index…');
  return {
    setBlocked(value: boolean) { blocked = value; updateControls(); },
    async reopenSaved() {
      checking = true;
      updateControls();
      report('checking', 'Checking for a saved NFCorpus index…');
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
            report('ready', 'Saved NFCorpus index opened automatically. Ready to search.');
          } else {
            ready = false;
            report('missing', 'First visit: prepare NFCorpus here, then enter a query on Search.');
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
