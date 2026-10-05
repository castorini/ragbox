import { describe, expect, it, vi } from 'vitest';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { queryBM25, retrieveMSMarco, retrieveNFCorpus } from '../src/collection-retrieval.ts';

function connection(rows: object[], columns = ['id', 'title', 'text', 'contents']) {
  const statement = { query: vi.fn(async () => ({ toArray: () => rows })), close: vi.fn(async () => {}) };
  const conn = { prepare: vi.fn(async () => statement), query: vi.fn(async () => ({ toArray: () => columns.map(column_name => ({ column_name })) })) };
  return { conn: conn as unknown as AsyncDuckDBConnection, statement, prepare: conn.prepare };
}
describe('shared collection retrieval', () => {
  it('binds NFCorpus queries, normalizes evidence and scores, and closes the statement', async () => {
    const h = connection([{ id: 'MED-1', title: 'Coffee', text: 'Evidence', score: 2 }]);
    const query = "coffee'; DROP TABLE nfcorpus; --";
    const result = await retrieveNFCorpus(h.conn, query);
    expect(h.statement.query).toHaveBeenCalledWith(query); expect(h.prepare.mock.calls[0]).not.toContain(query);
    expect(result.documents).toEqual([{ id: 'MED-1', title: 'Coffee', text: 'Evidence', score: 2 }]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0); expect(h.statement.close).toHaveBeenCalledOnce();
  });
  it('supports old NFCorpus tables and normalized MS MARCO passage IDs', async () => {
    const nf = connection([{ id: 'MED-2', title: 'Document MED-2', text: 'Old evidence', score: 1 }], ['id', 'contents']);
    await retrieveNFCorpus(nf.conn, 'query');
    expect(nf.prepare).toHaveBeenCalledWith(expect.stringContaining('contents AS text'));
    const marco = connection([{ id: 123n, contents: 'A passage', score: 3 }]);
    await expect(retrieveMSMarco(marco.conn, 'query')).resolves.toMatchObject({ documents: [{ id: 'MARCO-123', title: 'Passage 123', text: 'A passage', score: 3 }] });
  });
  it('closes failed queries and rejects incompatible tables before querying', async () => {
    const h = connection([], ['contents']); h.statement.query.mockRejectedValue(new Error('Query failed'));
    await expect(queryBM25(h.conn, 'SELECT ?', 'question')).rejects.toThrow('Query failed'); expect(h.statement.close).toHaveBeenCalledOnce();
    h.prepare.mockClear(); await expect(retrieveNFCorpus(h.conn, 'question')).rejects.toThrow('incompatible'); expect(h.prepare).not.toHaveBeenCalled();
  });
});
