import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { RetrievalResult, SearchResult } from './types.ts';

type Connection = Pick<AsyncDuckDBConnection, 'prepare' | 'query'>;

// Older saved FTS macros stem query stopwords even though indexing drops them.
// Use the saved analyzer before stemming so "of" cannot match a rare "ofs" stem.
async function normalizeQuery(conn: Pick<Connection, 'prepare'>, ftsSchema: 'fts_main_nfcorpus' | 'fts_main_msmarco', query: string) {
  // Normalize separately so the large retrieval macro receives a plain bound
  // value, preserving its efficient plan instead of expanding a subquery.
  const sql = `WITH query_tokens AS (
    SELECT unnest(${ftsSchema}.tokenize(?)) AS token
  )
    SELECT coalesce(string_agg(token, ' '), '') AS query_text
    FROM query_tokens
    WHERE token IS NOT NULL AND token <> ''
      AND token NOT IN (SELECT sw FROM ${ftsSchema}.stopwords)`;
  const rows = await queryBM25<{ query_text: string }>(conn, sql, query);
  return rows[0]?.query_text ?? '';
}

export const NFCORPUS_SEARCH_SQL = `
  SELECT id, title, text,
         fts_main_nfcorpus.match_bm25(id, ?) AS score
  FROM nfcorpus
  WHERE score IS NOT NULL
  ORDER BY score DESC, id
  LIMIT 10
`;
export const MSMARCO_SEARCH_SQL = `SELECT id, contents,
        fts_main_msmarco.match_bm25(id, ?) AS score FROM msmarco
        WHERE score IS NOT NULL ORDER BY score DESC, id LIMIT 10`;

export async function queryBM25<T>(conn: Pick<Connection, 'prepare'>, sql: string, query: string): Promise<T[]> {
  const statement = await conn.prepare(sql);
  try { return (await statement.query(query)).toArray() as T[]; }
  finally { await statement.close(); }
}

export async function nfcorpusSearchSQL(conn: Pick<Connection, 'query'>): Promise<string> {
  const schema = await conn.query(`SELECT column_name FROM information_schema.columns
      WHERE table_catalog = current_database() AND table_schema = 'main'
        AND table_name = 'nfcorpus'`);
  const columns = new Set((schema.toArray() as { column_name: string }[]).map(row => row.column_name));
  if (!columns.has('id') || !columns.has('contents')) {
    throw new Error('The saved NFCorpus table is incompatible: document IDs and contents are required.');
  }
  const title = columns.has('title') ? 'title' : "'Document ' || CAST(id AS VARCHAR) AS title";
  const text = columns.has('text') ? 'text' : 'contents AS text';
  return NFCORPUS_SEARCH_SQL.replace('SELECT id, title, text,', `SELECT id, ${title}, ${text},`);
}

export async function retrieveNFCorpus(conn: Connection, query: string): Promise<RetrievalResult> {
  const start = performance.now();
  const normalized = await normalizeQuery(conn, 'fts_main_nfcorpus', query);
  if (!normalized) return { documents: [], elapsedMs: performance.now() - start };
  const sql = await nfcorpusSearchSQL(conn);
  const rows = await queryBM25<SearchResult>(conn, sql, normalized);
  return { documents: rows.map(row => ({ id: String(row.id), title: String(row.title), text: String(row.text), score: Number(row.score) })), elapsedMs: performance.now() - start };
}

export async function retrieveMSMarco(conn: Pick<Connection, 'prepare'>, query: string): Promise<RetrievalResult> {
  const start = performance.now();
  const normalized = await normalizeQuery(conn, 'fts_main_msmarco', query);
  if (!normalized) return { documents: [], elapsedMs: performance.now() - start };
  const rows = await queryBM25<{ id: string | number | bigint; contents: string; score: number }>(conn, MSMARCO_SEARCH_SQL, normalized);
  return { documents: rows.map(row => ({ id: `MARCO-${String(row.id)}`, title: `Passage ${String(row.id)}`, text: String(row.contents ?? ''), score: Number(row.score) })), elapsedMs: performance.now() - start };
}
