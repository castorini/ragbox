import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupNFCorpus } from '../src/nfcorpus.ts';
import { FakeElements, fakeElement } from './fake-elements.ts';

let elements: FakeElements;

function createLLM() {
  return {
    beginRetrieval: vi.fn(),
    generate: vi.fn(),
    showRetrievalMessage: vi.fn(),
  };
}

function resultSet(rows: unknown[]) {
  return { toArray: () => rows };
}

function createConnection(rows: unknown[], columns = ['id', 'title', 'text', 'contents']) {
  const statement = {
    query: vi.fn().mockResolvedValue(resultSet(rows)),
    close: vi.fn(),
  };
  const conn = {
    prepare: vi.fn().mockResolvedValue(statement),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.columns')) return resultSet(columns.map(column_name => ({ column_name })));
      if (sql.includes('information_schema.schemata')) return resultSet([{ n: 1 }]);
      if (sql.includes('information_schema.tables')) return resultSet([{ n: 1 }]);
      return resultSet([]);
    }),
  };
  return { conn, statement };
}

function start(conn: ReturnType<typeof createConnection>['conn'], llm = createLLM()) {
  return setupNFCorpus(
    {} as Parameters<typeof setupNFCorpus>[0],
    conn as unknown as Parameters<typeof setupNFCorpus>[1],
    task => task(),
    llm,
  );
}

beforeEach(() => {
  elements = new FakeElements();
  vi.stubGlobal('document', {
    querySelector: (selector: string) => elements.get(selector),
    createElement: fakeElement,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('NFCorpus shared LLM integration', () => {
  it('hides the entire setup after validating a saved index and keeps search blocked during other work', async () => {
    const { conn } = createConnection([]);
    const controller = start(conn);
    expect(elements.get('#fts-setup').hidden).toBe(false);
    expect(elements.get('#fts-index').disabled).toBe(false);
    expect(elements.get('#fts-search').disabled).toBe(true);
    await controller.reopenSaved();
    expect(elements.get('#fts-setup').hidden).toBe(true);
    expect(elements.get('#fts-search').disabled).toBe(false);
    controller.setBlocked(true);
    expect(elements.get('#fts-search').disabled).toBe(true);
    controller.setBlocked(false);
    expect(elements.get('#fts-search').disabled).toBe(false);
  });

  it('searches older saved collections with only id and contents', async () => {
    const rows = [{ id: 'MED-14', title: 'Document MED-14', text: 'Health research', score: 4 }];
    const { conn } = createConnection(rows, ['id', 'contents']);
    const llm = createLLM();
    const controller = start(conn, llm);
    await controller.reopenSaved();
    elements.get('#fts-query').value = 'health';
    await elements.get('#fts-form').onsubmit({ preventDefault() {} });
    expect(conn.prepare).toHaveBeenLastCalledWith(expect.stringContaining("'Document ' || CAST(id AS VARCHAR) AS title, contents AS text"));
    expect(llm.generate).toHaveBeenCalledWith(expect.objectContaining({ documents: rows }));
    expect(elements.get('#fts-search').disabled).toBe(false);
  });

  it('restores the setup action when a saved index cannot bind the search', async () => {
    const { conn } = createConnection([]);
    conn.prepare.mockRejectedValueOnce(new Error('Saved index cannot be read'));
    const controller = start(conn);
    await expect(controller.reopenSaved()).rejects.toThrow('Saved index cannot be read');
    controller.setBlocked(false);
    expect(elements.get('#fts-setup').hidden).toBe(false);
    expect(elements.get('#fts-index').hidden).toBe(false);
    expect(elements.get('#fts-index').disabled).toBe(false);
    expect(elements.get('#fts-index').textContent).toBe('Retry preparing NFCorpus');
    expect(elements.get('#fts-search').disabled).toBe(true);
    expect(elements.get('#fts-status').textContent).toContain('Retry preparing NFCorpus');
    await controller.reopenSaved();
    expect(elements.get('#fts-setup').hidden).toBe(true);
    expect(elements.get('#fts-search').disabled).toBe(false);
  });

  it('preserves NFCorpus anchors and sends its ranked evidence to the shared controller', async () => {
    const rows = [{
      id: 'MED-14',
      title: 'Walking and health',
      text: 'Walking was associated with an outcome.',
      score: 4.25,
    }];
    const { conn, statement } = createConnection(rows);
    const llm = createLLM();
    start(conn, llm);
    elements.get('#fts-query').value = 'walking';

    await elements.get('#fts-form').onsubmit({ preventDefault() {} });

    expect(llm.beginRetrieval).toHaveBeenCalledWith('nfcorpus');
    expect(statement.query).toHaveBeenCalledWith('walking');
    expect(statement.close).toHaveBeenCalledOnce();
    expect(elements.get('#fts-results').children[0]).toMatchObject({
      id: 'fts-result-MED-14',
      tabIndex: -1,
    });
    expect(llm.generate).toHaveBeenCalledOnce();
    const request = llm.generate.mock.calls[0][0];
    expect(request).toMatchObject({
      corpus: 'nfcorpus',
      question: 'walking',
      documents: rows,
      evidenceLabel: 'documents',
    });
    expect([...request.citationTargets]).toEqual([
      ['MED-14', '#fts-result-MED-14'],
    ]);
  });

  it('keeps NFCorpus retrieval usable without generation when no matches are found', async () => {
    const { conn } = createConnection([]);
    const llm = createLLM();
    start(conn, llm);
    elements.get('#fts-query').value = 'no matches';

    await elements.get('#fts-form').onsubmit({ preventDefault() {} });

    expect(llm.beginRetrieval).toHaveBeenCalledWith('nfcorpus');
    expect(llm.generate).not.toHaveBeenCalled();
    expect(llm.showRetrievalMessage).toHaveBeenLastCalledWith(
      'nfcorpus',
      'No retrieved documents support an answer for this query.',
    );
  });
});
