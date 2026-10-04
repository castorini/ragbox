import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupNFCorpus } from '../src/nfcorpus.ts';
import { FakeElements, fakeElement } from './fake-elements.ts';
import { SearchHistory } from '../src/history.ts';

let elements: FakeElements;

function createLLM() {
  return {
    beginRetrieval: vi.fn(),
    generate: vi.fn(),
    showRetrievalMessage: vi.fn(),
    isCurrentSearch: vi.fn(() => true),
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

function start(conn: ReturnType<typeof createConnection>['conn'], llm = createLLM(), history?: SearchHistory) {
  return setupNFCorpus(
    {} as Parameters<typeof setupNFCorpus>[0],
    conn as unknown as Parameters<typeof setupNFCorpus>[1],
    task => task(),
    llm, undefined, undefined, history,
  );
}

beforeEach(() => {
  elements = new FakeElements();
  vi.stubGlobal('document', {
    querySelector: (selector: string) => elements.get(selector),
    createElement: fakeElement,
  });
});

it('ignores retrieval that finishes after its search session is invalidated', async () => {
  const rows = [{ id: 'MED-1', title: 'Old evidence', text: 'Old', score: 1 }];
  const { conn, statement } = createConnection(rows);
  const llm = createLLM();
  llm.beginRetrieval.mockReturnValue(7);
  const history = new SearchHistory(undefined);
  await start(conn, llm, history).reopenSaved();
  let finish!: (value: ReturnType<typeof resultSet>) => void;
  statement.query.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  elements.get('#fts-query').value = 'old';
  const searching = elements.get('#fts-form').onsubmit({ preventDefault() {} });
  await vi.waitFor(() => expect(statement.query).toHaveBeenCalled());
  llm.isCurrentSearch.mockReturnValue(false);
  elements.get('#fts-search-status').textContent = '';
  finish(resultSet(rows));
  await searching;
  expect(elements.get('#fts-results').children).toEqual([]);
  expect(elements.get('#fts-search-status').textContent).toBe('');
  expect(history.entries()).toEqual([]);
  expect(llm.generate).not.toHaveBeenCalled();
});

it('prepares through the shared method without submitting and attaches stopped and retried answers to one search', async () => {
  const rows = [{ id: 'MED-1', title: 'Evidence', text: 'Fact', score: 1 }];
  const { conn, statement } = createConnection(rows);
  const query = conn.query.getMockImplementation()!;
  conn.query.mockImplementation(async sql => sql.includes('SELECT count(*) AS n FROM nfcorpus')
    ? resultSet([{ n: 3633 }]) : query(sql));
  const llm = createLLM();
  const history = new SearchHistory(undefined);
  const controller = start(conn, llm, history);
  await controller.reopenSaved();
  elements.get('#fts-query').value = 'nutrition';
  await controller.prepare();
  expect(elements.get('#fts-query').value).toBe('nutrition');
  expect(elements.get('#fts-search').disabled).toBe(false);
  expect(statement.query).not.toHaveBeenCalled();
  expect(history.entries()).toEqual([]);
  await elements.get('#fts-form').onsubmit({ preventDefault() {} });
  const options = llm.generate.mock.calls[0][0];
  options.onStopped('Partial [MED-1]', ['MED-1']);
  expect(history.entries()[0]).toMatchObject({ answerStatus: 'stopped', answer: 'Partial [MED-1]' });
  options.onComplete('Complete [MED-1].', ['MED-1']);
  expect(history.entries()).toHaveLength(1);
  expect(history.entries()[0]).toMatchObject({ answerStatus: 'complete', answer: 'Complete [MED-1].' });
});

afterEach(() => vi.unstubAllGlobals());

describe('NFCorpus shared LLM integration', () => {
  it('keeps preparation disabled during the saved-index check, then offers it on first visit', async () => {
    const { conn } = createConnection([]);
    conn.query.mockImplementation(async sql => {
      if (sql.includes('information_schema.schemata')) return resultSet([{ n: 0 }]);
      return resultSet([]);
    });
    const controller = start(conn);
    expect(elements.get('#fts-index').disabled).toBe(true);
    await controller.reopenSaved();
    expect(elements.get('#fts-setup').hidden).toBe(false);
    expect(elements.get('#fts-index').disabled).toBe(false);
    expect(elements.get('#fts-search').disabled).toBe(true);
    expect(elements.get('#fts-status').textContent).toBe('Not prepared.');
  });

  it('hides the entire setup after validating a saved index and keeps search blocked during other work', async () => {
    const { conn } = createConnection([]);
    const controller = start(conn);
    expect(elements.get('#fts-setup').hidden).toBe(false);
    expect(elements.get('#fts-index').disabled).toBe(true);
    expect(elements.get('#fts-search').disabled).toBe(true);
    await controller.reopenSaved();
    expect(elements.get('#fts-setup').hidden).toBe(true);
    expect(elements.get('#fts-status').textContent).toBe('Ready to search.');
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
    await start(conn, llm).reopenSaved();
    statement.close.mockClear();
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
    await start(conn, llm).reopenSaved();
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
