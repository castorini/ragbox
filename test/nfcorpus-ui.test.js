import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupNFCorpus } from '../src/nfcorpus.js';

let elements;

function element(tagName = '') {
  return {
    tagName,
    id: '',
    tabIndex: 0,
    value: '',
    textContent: '',
    children: [],
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
  };
}

function createLLM() {
  return {
    beginRetrieval: vi.fn(),
    generate: vi.fn(),
    showRetrievalMessage: vi.fn(),
  };
}

function resultSet(rows) {
  return { toArray: () => rows };
}

function createConnection(rows) {
  const statement = {
    query: vi.fn().mockResolvedValue(resultSet(rows)),
    close: vi.fn(),
  };
  const conn = {
    prepare: vi.fn().mockResolvedValue(statement),
    query: vi.fn(async sql => {
      if (sql.includes('information_schema.schemata')) return resultSet([{ n: 1 }]);
      if (sql.includes('information_schema.tables')) return resultSet([{ n: 1 }]);
      return resultSet([]);
    }),
  };
  return { conn, statement };
}

beforeEach(() => {
  elements = new Map();
  vi.stubGlobal('document', {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: tagName => element(tagName),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('NFCorpus shared LLM integration', () => {
  it('preserves NFCorpus anchors and sends its ranked evidence to the shared controller', async () => {
    const rows = [{
      id: 'MED-14',
      title: 'Walking and health',
      text: 'Walking was associated with an outcome.',
      score: 4.25,
    }];
    const { conn, statement } = createConnection(rows);
    const llm = createLLM();
    setupNFCorpus({}, conn, task => task(), llm);
    document.querySelector('#fts-query').value = 'walking';

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
    setupNFCorpus({}, conn, task => task(), llm);
    document.querySelector('#fts-query').value = 'no matches';

    await elements.get('#fts-form').onsubmit({ preventDefault() {} });

    expect(llm.beginRetrieval).toHaveBeenCalledWith('nfcorpus');
    expect(llm.generate).not.toHaveBeenCalled();
    expect(llm.showRetrievalMessage).toHaveBeenLastCalledWith(
      'nfcorpus',
      'No retrieved documents support an answer for this query.',
    );
  });
});
