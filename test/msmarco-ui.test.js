import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/prebuilt-msmarco.js', () => ({
  openPrebuilt: vi.fn(),
  PREBUILT_NAME: 'msmarco-prebuilt.duckdb',
}));

import { openPrebuilt } from '../src/prebuilt-msmarco.js';
import { normalizeMSMarcoResults, setupMSMarco } from '../src/msmarco.js';

let elements;

function element(tagName = '') {
  return {
    tagName,
    id: '',
    tabIndex: 0,
    disabled: false,
    hidden: false,
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

function searchablePrebuilt(rows, overrides = {}) {
  const statement = {
    query: vi.fn().mockResolvedValue(resultSet(rows)),
    close: vi.fn(),
  };
  const prebuilt = {
    conn: { prepare: vi.fn().mockResolvedValue(statement) },
    count: 8_841_823,
    close: vi.fn(),
    ...overrides,
  };
  return { prebuilt, statement };
}

async function openAndSearch({ llm, prebuilt, query = "what's a corporation" }) {
  openPrebuilt.mockResolvedValue(prebuilt);
  setupMSMarco(task => task(), llm);
  await elements.get('#marco-reopen').onclick();
  document.querySelector('#marco-query').value = query;
  await elements.get('#marco-form').onsubmit({ preventDefault() {} });
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
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
  openPrebuilt.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('MS MARCO result conversion', () => {
  it('normalizes ranked passages into corpus-independent RAG documents', () => {
    expect(normalizeMSMarcoResults([
      { id: 12, contents: 'First passage', score: 9 },
      { id: '7', contents: null, score: 8 },
    ])).toEqual([
      { id: 'MARCO-12', title: 'Passage 12', text: 'First passage' },
      { id: 'MARCO-7', title: 'Passage 7', text: '' },
    ]);
  });
});

describe('MS MARCO search UI', () => {
  it('renders stable anchors, then generates from normalized passages with matching citations', async () => {
    const rows = [
      { id: '12', contents: '<script>text</script>', score: 3 },
      { id: '8/9', contents: 'Second passage', score: 2 },
    ];
    const { prebuilt, statement } = searchablePrebuilt(rows);
    const llm = createLLM();

    await openAndSearch({ llm, prebuilt });

    expect(statement.query).toHaveBeenCalledWith("what's a corporation");
    expect(statement.close).toHaveBeenCalledOnce();
    expect(llm.beginRetrieval).toHaveBeenCalledWith('msmarco');
    expect(elements.get('#marco-results').children).toHaveLength(2);
    expect(elements.get('#marco-results').children[0]).toMatchObject({
      id: 'marco-result-12',
      tabIndex: -1,
    });
    expect(elements.get('#marco-results').children[0].children[1].textContent)
      .toBe('<script>text</script>');
    expect(elements.get('#marco-results').children[1].id).toBe('marco-result-8%2F9');

    expect(llm.generate).toHaveBeenCalledOnce();
    const request = llm.generate.mock.calls[0][0];
    expect(request).toMatchObject({
      corpus: 'msmarco',
      question: "what's a corporation",
      evidenceLabel: 'passages',
      documents: [
        { id: 'MARCO-12', title: 'Passage 12', text: '<script>text</script>' },
        { id: 'MARCO-8/9', title: 'Passage 8/9', text: 'Second passage' },
      ],
    });
    expect([...request.citationTargets]).toEqual([
      ['MARCO-12', '#marco-result-12'],
      ['MARCO-8/9', '#marco-result-8%2F9'],
    ]);
  });

  it('clears stale generation and skips the model when retrieval is empty', async () => {
    const { prebuilt } = searchablePrebuilt([]);
    const llm = createLLM();

    await openAndSearch({ llm, prebuilt, query: 'missing topic' });

    expect(llm.beginRetrieval).toHaveBeenCalledWith('msmarco');
    expect(llm.generate).not.toHaveBeenCalled();
    expect(llm.showRetrievalMessage).toHaveBeenLastCalledWith(
      'msmarco',
      'No retrieved passages support an answer for this query.',
    );
    expect(elements.get('#marco-results').children).toEqual([]);
  });

  it('closes a failed statement, reports the failure, and skips generation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('query failed');
    const statement = { query: vi.fn().mockRejectedValue(failure), close: vi.fn() };
    const prebuilt = {
      conn: { prepare: vi.fn().mockResolvedValue(statement) },
      count: 8_841_823,
      close: vi.fn(),
    };
    const llm = createLLM();
    const run = vi.fn(async task => {
      try { return await task(); }
      catch { return undefined; }
    });
    openPrebuilt.mockResolvedValue(prebuilt);
    setupMSMarco(run, llm);
    await elements.get('#marco-reopen').onclick();
    document.querySelector('#marco-query').value = 'broken search';

    await elements.get('#marco-form').onsubmit({ preventDefault() {} });

    expect(statement.close).toHaveBeenCalledOnce();
    expect(llm.beginRetrieval).toHaveBeenCalledWith('msmarco');
    expect(llm.generate).not.toHaveBeenCalled();
    expect(llm.showRetrievalMessage).toHaveBeenLastCalledWith(
      'msmarco',
      'Retrieval failed, so answer generation was skipped.',
    );
  });

  it('keeps search disabled and provides download guidance when no saved file exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openPrebuilt.mockRejectedValue(new DOMException('missing', 'NotFoundError'));
    setupMSMarco();

    await elements.get('#marco-reopen').onclick();

    expect(elements.get('#marco-search').disabled).toBe(true);
    expect(elements.get('#marco-reopen').disabled).toBe(false);
    expect(elements.get('#marco-status').textContent).toContain('Download the index first');
  });

  it('disables all actions on an unsupported browser', () => {
    vi.stubGlobal('navigator', { storage: {} });
    setupMSMarco();

    for (const id of ['#marco-fetch', '#marco-reopen', '#marco-search']) {
      expect(elements.get(id).disabled).toBe(true);
    }
  });

  it('cancels the MS MARCO answer when replacing or closing its index', async () => {
    const first = searchablePrebuilt([]).prebuilt;
    const second = searchablePrebuilt([]).prebuilt;
    openPrebuilt.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const llm = createLLM();
    const run = vi.fn(task => task());
    const controller = setupMSMarco(run, llm);

    controller.setBlocked(true);
    await elements.get('#marco-reopen').onclick();
    expect(openPrebuilt).not.toHaveBeenCalled();

    controller.setBlocked(false);
    await elements.get('#marco-reopen').onclick();
    llm.showRetrievalMessage.mockClear();

    await elements.get('#marco-reopen').onclick();
    expect(first.close).toHaveBeenCalledOnce();
    expect(llm.showRetrievalMessage).toHaveBeenCalledWith('msmarco', '');

    llm.showRetrievalMessage.mockClear();
    await controller.close();
    expect(second.close).toHaveBeenCalledOnce();
    expect(llm.showRetrievalMessage).toHaveBeenCalledWith('msmarco', '');
    expect(elements.get('#marco-search').disabled).toBe(true);
  });
});
