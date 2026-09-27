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

export function setupNFCorpus(db, conn, run, llm) {
  const status = document.querySelector('#fts-status');
  const results = document.querySelector('#fts-results');
  let loaded = false;
  async function loadExtension() {
    if (loaded) return;
    status.textContent = 'Loading the DuckDB FTS extension…';
    await conn.query('INSTALL fts');
    await conn.query('LOAD fts');
    loaded = true;
  }
  const exists = async () => (await conn.query(`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_catalog = current_database()
      AND table_schema = 'main' AND table_name = 'nfcorpus'
  `)).toArray()[0].n > 0;

  async function action(task) {
    return run(async () => {
      results.replaceChildren();
      try { return await task(); }
      catch (error) {
        status.textContent = `FTS error: ${error.message}`;
        throw error;
      }
    });
  }

  document.querySelector('#fts-index').onclick = () => action(async () => {
    llm.showRetrievalMessage('nfcorpus', '');
    await loadExtension();
    if (!await exists()) {
      status.textContent = 'Loading NFCorpus documents…';
      const response = await fetch(`${import.meta.env.BASE_URL}data/nfcorpus.jsonl`);
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
        throw new Error('Dataset missing. Run npm run prepare:nfcorpus -- /path/to/corpus.jsonl first.');
      }
      const contents = await response.text();
      const rows = contents.trim().split(/\r?\n/).map(JSON.parse);
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
    status.textContent = 'Building the full-text index in your browser…';
    const start = performance.now();
    await conn.query(INDEX_SQL);
    await conn.query('CHECKPOINT');
    const count = (await conn.query('SELECT count(*) AS n FROM nfcorpus')).toArray()[0].n;
    const version = (await conn.query('SELECT version() AS version')).toArray()[0].version;
    status.textContent = `${count} documents indexed in ${((performance.now() - start) / 1000).toFixed(2)} s. ${version}. Ready to search.`;
  });

  document.querySelector('#fts-form').onsubmit = event => {
    event.preventDefault();
    const query = document.querySelector('#fts-query').value.trim();
    if (!query) return;
    llm.beginRetrieval('nfcorpus');
    return action(async () => {
      await loadExtension();
      const index = await conn.query(`SELECT count(*) AS n FROM information_schema.schemata
        WHERE schema_name = 'fts_main_nfcorpus' AND catalog_name = current_database()`);
      if (!await exists() || Number(index.toArray()[0].n) === 0) {
        status.textContent = 'Click “Load NFCorpus & build FTS index” before searching.';
        return null;
      }
      status.textContent = 'Searching saved NFCorpus documents…';
      const start = performance.now();
      const statement = await conn.prepare(SEARCH_SQL);
      let rows;
      try { rows = (await statement.query(query)).toArray(); }
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
      status.textContent = rows.length
        ? `Showing the top ${rows.length} matches for “${query}” (${(performance.now() - start).toFixed(0)} ms, including rendering).`
        : `No matches for “${query}”. Try different terms; common stopwords are excluded.`;
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
}
