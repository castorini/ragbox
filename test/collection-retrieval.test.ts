import { describe, expect, it, vi } from 'vitest';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { NFCORPUS_SEARCH_SQL, MSMARCO_SEARCH_SQL, queryBM25, retrieveMSMarco, retrieveNFCorpus } from '../src/collection-retrieval.ts';

function connection(rows: object[], columns = ['id', 'title', 'text', 'contents'], normalized = 'query') {
  const normalization = { query: vi.fn(async (_query: string) => ({ toArray: () => [{ query_text: normalized }] })), close: vi.fn(async () => {}) };
  const statement = { query: vi.fn(async (_query: string) => ({ toArray: () => rows })), close: vi.fn(async () => {}) };
  const conn = {
    prepare: vi.fn(async (sql: string) => sql.includes('AS query_text') ? normalization : statement),
    query: vi.fn(async (_sql: string) => ({ toArray: () => columns.map(column_name => ({ column_name })) })),
  };
  return { conn: conn as unknown as AsyncDuckDBConnection, statement, normalization, prepare: conn.prepare, schema: conn.query };
}

function retrieve(corpus: 'nfcorpus' | 'msmarco', conn: AsyncDuckDBConnection, query: string) {
  return corpus === 'nfcorpus' ? retrieveNFCorpus(conn, query) : retrieveMSMarco(conn, query);
}

describe('shared collection retrieval', () => {
  it.each([
    ['nfcorpus', NFCORPUS_SEARCH_SQL],
    ['msmarco', MSMARCO_SEARCH_SQL],
  ])('keeps the efficient %s BM25 SQL with a plain bound query', (table, sql) => {
    expect(sql).toContain(`fts_main_${table}.match_bm25(id, ?) AS score`);
    expect(sql).toContain(`FROM ${table}`);
    expect(sql).toMatch(/ORDER BY score DESC, id\s+LIMIT 10/);
    expect(sql).not.toContain('tokenize');
    expect(sql).not.toContain('SELECT query_text');
    expect(sql.match(/\?/g)).toHaveLength(1);
  });

  it.each(['nfcorpus', 'msmarco'] as const)('normalizes %s using its saved analyzer in a separate small statement', async corpus => {
    const h = connection([], undefined, 'capital france');
    await retrieve(corpus, h.conn, 'What is the capital of France?');
    expect(h.prepare).toHaveBeenCalledTimes(2);
    const normalizationSQL = h.prepare.mock.calls[0][0];
    expect(normalizationSQL).toContain(`SELECT unnest(fts_main_${corpus}.tokenize(?)) AS token`);
    expect(normalizationSQL).toContain("WHERE token IS NOT NULL AND token <> ''");
    expect(normalizationSQL).toContain(`token NOT IN (SELECT sw FROM fts_main_${corpus}.stopwords)`);
    expect(normalizationSQL).toContain("coalesce(string_agg(token, ' '), '') AS query_text");
    expect(normalizationSQL).not.toMatch(/\bFROM (?:nfcorpus|msmarco)\b/);
    expect(normalizationSQL.match(/\?/g)).toHaveLength(1);
    expect(h.normalization.query).toHaveBeenCalledExactlyOnceWith('What is the capital of France?');
    expect(h.statement.query).toHaveBeenCalledExactlyOnceWith('capital france');
    expect(h.normalization.close).toHaveBeenCalledOnce();
    expect(h.statement.close).toHaveBeenCalledOnce();
    expect(h.normalization.close.mock.invocationCallOrder[0]).toBeLessThan(h.statement.query.mock.invocationCallOrder[0]);
  });

  it('normalizes NFCorpus evidence and scores without changing result snapshots', async () => {
    const h = connection([{ id: 'MED-1', title: 'Coffee', text: 'Evidence', score: 2 }], undefined, 'coffee');
    const result = await retrieveNFCorpus(h.conn, 'What is known about coffee?');
    expect(result.documents).toEqual([{ id: 'MED-1', title: 'Coffee', text: 'Evidence', score: 2 }]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(h.normalization.query).toHaveBeenCalledExactlyOnceWith('What is known about coffee?');
    expect(h.statement.query).toHaveBeenCalledExactlyOnceWith('coffee');
  });

  it('supports old NFCorpus tables and normalized MS MARCO passage IDs', async () => {
    const nf = connection([{ id: 'MED-2', title: 'Document MED-2', text: 'Old evidence', score: 1 }], ['id', 'contents']);
    await retrieveNFCorpus(nf.conn, 'query');
    expect(nf.prepare.mock.calls[0][0]).toContain('fts_main_nfcorpus.tokenize(?)');
    expect(nf.prepare.mock.calls[0][0]).toContain('SELECT sw FROM fts_main_nfcorpus.stopwords');
    expect(nf.prepare.mock.calls[1][0]).toContain('contents AS text');
    expect(nf.prepare.mock.calls[1][0]).toContain("'Document ' || CAST(id AS VARCHAR) AS title");
    expect(nf.prepare.mock.calls[1][0]).toContain('match_bm25(id, ?)');
    const marco = connection([{ id: 123n, contents: 'A passage', score: 3 }]);
    await expect(retrieveMSMarco(marco.conn, 'query')).resolves.toMatchObject({ documents: [{ id: 'MARCO-123', title: 'Passage 123', text: 'A passage', score: 3 }] });
  });

  it.each(['nfcorpus', 'msmarco'] as const)('keeps both %s statements parameter-bound for SQL-looking input', async corpus => {
    const query = "What is the capital of France?'; DROP TABLE msmarco; --";
    const normalized = "capital france'; DROP TABLE msmarco; --";
    const h = connection([], undefined, normalized);
    await retrieve(corpus, h.conn, query);
    expect(h.normalization.query).toHaveBeenCalledExactlyOnceWith(query);
    expect(h.statement.query).toHaveBeenCalledExactlyOnceWith(normalized);
    for (const [sql] of h.prepare.mock.calls) {
      expect(sql).not.toContain(query);
      expect(sql).not.toContain(normalized);
      expect(sql.match(/\?/g)).toHaveLength(1);
    }
    expect(h.normalization.close).toHaveBeenCalledOnce();
    expect(h.statement.close).toHaveBeenCalledOnce();
  });

  it.each(['nfcorpus', 'msmarco'] as const)('skips %s schema inspection and retrieval when normalization is empty', async corpus => {
    const h = connection([], undefined, '');
    const result = await retrieve(corpus, h.conn, 'What is the of?');
    expect(result.documents).toEqual([]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(h.normalization.query).toHaveBeenCalledExactlyOnceWith('What is the of?');
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.normalization.close).toHaveBeenCalledOnce();
    expect(h.statement.query).not.toHaveBeenCalled();
    expect(h.statement.close).not.toHaveBeenCalled();
    expect(h.schema).not.toHaveBeenCalled();
  });

  it.each([
    ['nfcorpus', 'normalization'], ['msmarco', 'normalization'],
    ['nfcorpus', 'retrieval'], ['msmarco', 'retrieval'],
  ] as const)('closes the opened %s statements when %s fails', async (corpus, stage) => {
    const h = connection([]);
    (stage === 'normalization' ? h.normalization : h.statement).query.mockRejectedValue(new Error('Query failed'));
    await expect(retrieve(corpus, h.conn, 'question')).rejects.toThrow('Query failed');
    expect(h.normalization.close).toHaveBeenCalledOnce();
    if (stage === 'normalization') {
      expect(h.prepare).toHaveBeenCalledOnce();
      expect(h.statement.query).not.toHaveBeenCalled();
      expect(h.statement.close).not.toHaveBeenCalled();
    } else {
      expect(h.prepare).toHaveBeenCalledTimes(2);
      expect(h.statement.close).toHaveBeenCalledOnce();
    }
  });

  it('retains queryBM25 cleanup and rejects incompatible NFCorpus tables before collection retrieval', async () => {
    const direct = connection([]);
    direct.statement.query.mockRejectedValue(new Error('Query failed'));
    await expect(queryBM25(direct.conn, 'SELECT ?', 'question')).rejects.toThrow('Query failed');
    expect(direct.statement.close).toHaveBeenCalledOnce();
    const incompatible = connection([], ['contents']);
    await expect(retrieveNFCorpus(incompatible.conn, 'question')).rejects.toThrow('incompatible');
    expect(incompatible.prepare).toHaveBeenCalledOnce();
    expect(incompatible.normalization.close).toHaveBeenCalledOnce();
    expect(incompatible.statement.query).not.toHaveBeenCalled();
  });
});
