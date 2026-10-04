import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/prebuilt-msmarco.ts', () => ({
  openPrebuilt: vi.fn(),
  PREBUILT_NAME: 'msmarco-prebuilt.duckdb',
}));

import { openPrebuilt } from '../src/prebuilt-msmarco.ts';
import { normalizeMSMarcoResults, setupMSMarco } from '../src/msmarco.ts';
import { FakeElements, fakeElement } from './fake-elements.ts';
import type { RunTask } from '../src/types.ts';
import { LoadCoordinator } from '../src/load-coordinator.ts';

const mockedOpenPrebuilt = vi.mocked(openPrebuilt);
let elements: FakeElements;
let getDirectory = vi.fn();

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

function searchablePrebuilt(rows: unknown[], overrides: Record<string, unknown> = {}) {
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

function asIndex(value: unknown): Awaited<ReturnType<typeof openPrebuilt>> {
  return value as Awaited<ReturnType<typeof openPrebuilt>>;
}

async function openAndSearch({ llm, prebuilt, query = "what's a corporation" }: {
  llm: ReturnType<typeof createLLM>;
  prebuilt: ReturnType<typeof searchablePrebuilt>['prebuilt'];
  query?: string;
}) {
  mockedOpenPrebuilt.mockResolvedValue(asIndex(prebuilt));
  setupMSMarco(task => task(), llm);
  await elements.get('#marco-reopen').onclick();
  elements.get('#marco-query').value = query;
  await elements.get('#marco-form').onsubmit({ preventDefault() {} });
}

beforeEach(() => {
  elements = new FakeElements();
  vi.stubGlobal('document', {
    querySelector: (selector: string) => elements.get(selector),
    createElement: fakeElement,
  });
  vi.stubGlobal('window', { isSecureContext: true });
  getDirectory = vi.fn();
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  mockedOpenPrebuilt.mockReset();
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

    expect(elements.get('#marco-setup').hidden).toBe(true);
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

  it('identifies MS MARCO as the owner of its search operation', async () => {
    const { prebuilt } = searchablePrebuilt([]);
    const owners: Array<string | undefined> = [];
    const run: RunTask = (task, owner) => {
      owners.push(owner);
      return task();
    };
    mockedOpenPrebuilt.mockResolvedValue(asIndex(prebuilt));
    setupMSMarco(run, createLLM());
    await elements.get('#marco-reopen').onclick();
    elements.get('#marco-query').value = 'lung cancer';

    await elements.get('#marco-form').onsubmit({ preventDefault() {} });

    expect(owners.at(-1)).toBe('msmarco');
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
    const run: RunTask = async task => {
      try { return await task(); }
      catch { return undefined; }
    };
    mockedOpenPrebuilt.mockResolvedValue(asIndex(prebuilt));
    setupMSMarco(run, llm);
    await elements.get('#marco-reopen').onclick();
    elements.get('#marco-query').value = 'broken search';

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
    mockedOpenPrebuilt.mockRejectedValue(new DOMException('missing', 'NotFoundError'));
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
    mockedOpenPrebuilt.mockResolvedValueOnce(asIndex(first)).mockResolvedValueOnce(asIndex(second));
    const llm = createLLM();
    const run: RunTask = task => task();
    const controller = setupMSMarco(run, llm);

    controller.setBlocked(true);
    const pendingOpen = elements.get('#marco-reopen').onclick();
    await Promise.resolve();
    expect(openPrebuilt).not.toHaveBeenCalled();

    controller.setBlocked(false);
    await pendingOpen;
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

it('opens an existing OPFS index automatically and enables search', async () => {
  getDirectory.mockResolvedValue({ getFileHandle: vi.fn().mockResolvedValue({}) });
  mockedOpenPrebuilt.mockResolvedValue(asIndex(searchablePrebuilt([]).prebuilt));
  const controller = setupMSMarco(task => task(), createLLM());
  await controller.reopenSaved();
  expect(openPrebuilt).toHaveBeenCalledOnce();
  expect(elements.get('#marco-fetch').hidden).toBe(true);
  expect(elements.get('#marco-reopen').hidden).toBe(true);
  expect(elements.get('#marco-search').disabled).toBe(false);
});
it('does not create or download an index when no saved file exists', async () => {
  getDirectory.mockResolvedValue({ getFileHandle: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')) });
  const controller = setupMSMarco(task => task(), createLLM());
  await controller.reopenSaved();
  expect(openPrebuilt).not.toHaveBeenCalled();
  expect(elements.get('#marco-fetch').hidden).toBe(false);
  expect(elements.get('#marco-reopen').hidden).toBe(true);
  expect(elements.get('#marco-search').disabled).toBe(true);
});

it('checks a saved MS MARCO index without opening it until selected', async () => {
  getDirectory.mockResolvedValue({ getFileHandle: vi.fn().mockResolvedValue({}) });
  mockedOpenPrebuilt.mockResolvedValue(asIndex(searchablePrebuilt([]).prebuilt));
  const controller = setupMSMarco(task => task(), createLLM());
  await controller.checkSaved();
  expect(openPrebuilt).not.toHaveBeenCalled();
  expect(elements.get('#marco-status').textContent).toBe('Saved index available.');
  expect(elements.get('#marco-reopen').hidden).toBe(false);
  expect(elements.get('#marco-search').disabled).toBe(true);
  await controller.reopenSaved();
  expect(openPrebuilt).toHaveBeenCalledOnce();
  expect(elements.get('#marco-search').disabled).toBe(false);
});

it('queues saved-index opening without blocking unrelated search while a model loads', async () => {
  getDirectory.mockResolvedValue({ getFileHandle: vi.fn().mockResolvedValue({}) });
  mockedOpenPrebuilt.mockResolvedValue(asIndex(searchablePrebuilt([]).prebuilt));
  const loads = new LoadCoordinator();
  let finishModel!: () => void;
  const modelLoad = loads.run(() => new Promise<void>(resolve => { finishModel = resolve; }));
  await Promise.resolve();
  let runCalls = 0;
  const run: RunTask = task => { runCalls++; return task(); };
  const controller = setupMSMarco(run, createLLM(), undefined, loads);
  await controller.checkSaved();
  const opening = controller.reopenSaved();
  expect(elements.get('#marco-reopen').disabled).toBe(true);
  expect(runCalls).toBe(0);
  expect(openPrebuilt).not.toHaveBeenCalled();
  finishModel();
  await modelLoad;
  await opening;
  expect(runCalls).toBe(1);
  expect(openPrebuilt).toHaveBeenCalledOnce();
});
