import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { errorMessage, rowsAs } from '../boundaries.ts';
import type { RunTask } from '../types.ts';
import { ResourceStates, type ResourcePhase } from '../resource-state.ts';
import type { LoadCoordinator } from '../load-coordinator.ts';
import { NFCORPUS_SEARCH_SQL, nfcorpusSearchSQL, retrieveNFCorpus } from '../collection-retrieval.ts';

// FTS executes through the same DuckDB-Wasm worker and persistent OPFS database.
export const SEARCH_SQL = NFCORPUS_SEARCH_SQL;
export const INDEX_SQL = `PRAGMA create_fts_index(
  'nfcorpus', 'id', 'contents', overwrite = 1
)`;

export function createNFCorpusService(db: Pick<AsyncDuckDB, 'registerFileText' | 'dropFile'>, conn: Pick<AsyncDuckDBConnection, 'query' | 'prepare'>, run: RunTask, onState?: (phase: ResourcePhase, message: string) => void, loads?: LoadCoordinator, gate = new ResourceStates()) {
  let ready = false;
  let searchSQL = SEARCH_SQL;
  let loaded = false;
  let queued = false;
  let checking = true;
  function report(phase: ResourcePhase, message: string) {
    onState?.(phase, message);
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
      try { return await task(); }
      catch (error) {
        ready = false;
        report('error', `Could not open or search NFCorpus: ${errorMessage(error)}. Retry preparing NFCorpus.`);
        throw error;
      }
    }, searching ? 'nfcorpus' : undefined);
  }

  async function prepare() {
    if (queued || checking || gate.busy || gate.shuttingDown) return;
    queued = true;
    report('preparing', 'Waiting to prepare index…');
    try {
      const prepare = () => action(async () => {
        ready = false;
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
        report('ready', `Ready to search · ${count.toLocaleString()} documents.`);
      });
      return await (loads ? loads.run(prepare) : prepare());
    } finally {
      queued = false;
    }
  }
  onState?.('checking', 'Checking saved index…');
  return {
    prepare,
    async retrieve(query: string) {
      if (!ready || gate.busy || queued || checking || gate.shuttingDown) throw new Error('NFCorpus is not ready to search.');
      const result = await action(() => retrieveNFCorpus(conn, query), true);
      if (!result) throw new Error('NFCorpus search could not run.');
      return result;
    },
    setBlocked(value: boolean) { gate.setBusy(value); },
    dispose() {},
    async reopenSaved() {
      checking = true;
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
        });
      } finally {
        checking = false;
      }
    },
  };
}
