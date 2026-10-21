import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNFCorpusService, INDEX_SQL } from '../src/services/nfcorpus.ts';
import { createMSMarcoService, normalizeMSMarcoResults } from '../src/services/msmarco.ts';
import { ResourceStates } from '../src/resource-state.ts';
import type { RunTask } from '../src/types.ts';
import { LoadCoordinator } from '../src/load-coordinator.ts';
import { openPrebuilt } from '../src/prebuilt-msmarco.ts';
import { downloadPrebuilt } from '../src/download-prebuilt.ts';
vi.mock('../src/prebuilt-msmarco.ts', () => ({ openPrebuilt: vi.fn(), PREBUILT_NAME: 'msmarco-prebuilt.duckdb' }));
vi.mock('../src/download-prebuilt.ts', () => ({ downloadPrebuilt: vi.fn() }));
const result = (rows: unknown[]) => ({ toArray: () => rows });
function nfHarness(saved = true) {
  const states = new ResourceStates();
  const statement = { query: vi.fn().mockResolvedValue(result([{ query_text: 'nuts' }])), close: vi.fn() };
  const conn = { prepare: vi.fn().mockResolvedValue(statement), query: vi.fn(async (sql: string) => {
    if (sql.includes('information_schema.columns')) return result(['id', 'title', 'text', 'contents'].map(column_name => ({ column_name })));
    if (sql.includes('information_schema.schemata') || sql.includes('information_schema.tables')) return result([{ n: saved ? 1 : 0 }]);
    if (sql.includes('SELECT count(*) AS n FROM nfcorpus')) return result([{ n: 3633 }]);
    return result([]);
  }) };
  const db = { registerFileText: vi.fn(), dropFile: vi.fn() };
  const run = vi.fn(async <T>(task: () => Promise<T>) => task());
  const service = createNFCorpusService(db as never, conn as never, run as RunTask, (phase, message) => states.set('nfcorpus', phase, message), new LoadCoordinator(), states);
  return { states, statement, conn, db, run, service };
}
function marcoHarness() {
  vi.stubGlobal('isSecureContext', true);
  const getFileHandle = vi.fn().mockResolvedValue({});
  const getDirectory = vi.fn().mockResolvedValue({ getFileHandle });
  vi.stubGlobal('navigator', { storage: { getDirectory, estimate: vi.fn().mockResolvedValue({ quota: 10e9, usage: 0 }) } });
  const states = new ResourceStates();
  const service = createMSMarcoService(task => task(), (phase, message, progress, savedAvailable) => states.set('msmarco', phase, message, undefined, progress, savedAvailable), new LoadCoordinator(), states);
  const prebuilt = { count: 8_841_823, close: vi.fn().mockResolvedValue(undefined), conn: { prepare: vi.fn() } };
  vi.mocked(openPrebuilt).mockResolvedValue(prebuilt as never);
  return { service, states, getFileHandle, getDirectory, prebuilt };
}
beforeEach(() => { vi.mocked(openPrebuilt).mockReset(); vi.mocked(downloadPrebuilt).mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.unstubAllGlobals());
describe('DOM-independent NFCorpus service', () => {
  it('validates a saved FTS index and binds a query before reporting ready', async () => {
    const h = nfHarness(); await h.service.reopenSaved();
    expect(h.states.get('nfcorpus').phase).toBe('ready'); expect(h.conn.prepare).toHaveBeenCalled(); expect(h.statement.close).toHaveBeenCalled(); expect(h.conn.query).toHaveBeenCalledWith('LOAD fts');
  });
  it('reports an absent index without downloading a dataset', async () => {
    const h = nfHarness(false), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await h.service.reopenSaved(); expect(h.states.get('nfcorpus').phase).toBe('missing'); expect(fetch).not.toHaveBeenCalled();
    await expect(h.service.retrieve('nuts')).rejects.toThrow('not ready');
  });
  it('reports saved-index validation failure without marking the collection ready', async () => {
    const h = nfHarness(); h.conn.prepare.mockRejectedValue(new Error('Invalid macro'));
    await expect(h.service.reopenSaved()).rejects.toThrow('Invalid macro'); expect(h.states.get('nfcorpus').phase).toBe('error');
  });
  it('prepares a new collection, checkpoints it and releases the import buffer', async () => {
    const h = nfHarness(false); await h.service.reopenSaved();
    const contents = Array.from({ length: 3633 }, (_, id) => JSON.stringify({ id: `MED-${id}`, title: 'Title', text: 'Text' })).join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(contents)));
    await h.service.prepare(); expect(h.db.registerFileText).toHaveBeenCalledWith('nfcorpus-import.jsonl', contents);
    expect(h.db.dropFile).toHaveBeenCalledWith('nfcorpus-import.jsonl'); expect(h.conn.query).toHaveBeenCalledWith(INDEX_SQL); expect(h.conn.query).toHaveBeenCalledWith('CHECKPOINT');
    expect(h.states.get('nfcorpus').phase).toBe('ready');
  });
  it.each([new Response('Not found', { status: 404 }), new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }), new Response('{"id":"one"}')])('rejects missing, HTML or incomplete dataset input', async response => {
    const h = nfHarness(false); await h.service.reopenSaved(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(h.service.prepare()).rejects.toThrow(); expect(h.states.get('nfcorpus').phase).toBe('error'); expect(h.db.registerFileText).not.toHaveBeenCalled();
  });
  it('gates preparation and retrieval while another operation is active or shutdown has begun', async () => {
    const h = nfHarness(); await h.service.reopenSaved(); h.states.setBusy(true); await h.service.prepare(); await expect(h.service.retrieve('nuts')).rejects.toThrow('not ready');
    h.states.setBusy(false); h.states.beginShutdown(); await h.service.prepare(); expect(h.db.registerFileText).not.toHaveBeenCalled();
  });
});
describe('DOM-independent MS MARCO service', () => {
  it('normalizes numeric IDs and missing passage text', () => expect(normalizeMSMarcoResults([{ id: 12, contents: 'Passage' }, { id: 7n, contents: null }])).toEqual([{ id: 'MARCO-12', title: 'Passage 12', text: 'Passage' }, { id: 'MARCO-7', title: 'Passage 7', text: '' }]));
  it('checks a saved file without opening its database and opens it when selected', async () => {
    const h = marcoHarness(); await h.service.checkSaved(); expect(h.states.get('msmarco').phase).toBe('saved'); expect(openPrebuilt).not.toHaveBeenCalled();
    await h.service.reopenSaved(); expect(h.states.get('msmarco').phase).toBe('ready'); expect(openPrebuilt).toHaveBeenCalledOnce(); await h.service.close();
  });
  it('distinguishes a missing file from a storage access failure', async () => {
    const h = marcoHarness(); h.getFileHandle.mockRejectedValue(new DOMException('Missing', 'NotFoundError')); await h.service.checkSaved(); expect(h.states.get('msmarco')).toMatchObject({ phase: 'missing', savedAvailable: false });
    h.getFileHandle.mockRejectedValue(new Error('Blocked')); await h.service.checkSaved(); expect(h.states.get('msmarco')).toMatchObject({ phase: 'error', savedAvailable: undefined }); await h.service.close();
  });
  it('deduplicates simultaneous saved checks and opens', async () => {
    const h = marcoHarness(); await Promise.all([h.service.checkSaved(), h.service.checkSaved()]); expect(h.getDirectory).toHaveBeenCalledOnce();
    await Promise.all([h.service.openSaved(), h.service.openSaved()]); expect(openPrebuilt).toHaveBeenCalledOnce(); await h.service.close();
  });
  it('reports opening failure and supports retrying the saved file', async () => {
    const h = marcoHarness(); await h.service.checkSaved(); vi.mocked(openPrebuilt).mockRejectedValueOnce(new Error('Invalid artifact'));
    await h.service.openSaved(); expect(h.states.get('msmarco')).toMatchObject({ phase: 'error', savedAvailable: true }); await h.service.openSaved(); expect(h.states.get('msmarco').phase).toBe('ready'); await h.service.close();
  });
  it('checks available quota before downloading', async () => {
    const h = marcoHarness(); vi.mocked(navigator.storage.estimate).mockResolvedValue({ quota: 100, usage: 0 });
    await h.service.download(); expect(downloadPrebuilt).not.toHaveBeenCalled(); expect(h.states.get('msmarco').message).toContain('Not enough'); await h.service.close();
  });
  it('publishes download progress and opens the committed artifact', async () => {
    const h = marcoHarness(); vi.mocked(downloadPrebuilt).mockImplementation(async options => { options.onProgress?.(options.bytes, options.bytes); expect(h.states.get('msmarco').progress).toBe(100); return options.bytes; });
    await h.service.download(); expect(downloadPrebuilt).toHaveBeenCalledOnce(); expect(h.states.get('msmarco')).toMatchObject({ phase: 'ready', savedAvailable: true }); await h.service.close();
  });
  it('cancels downloads without losing knowledge of an older committed artifact', async () => {
    const h = marcoHarness(); await h.service.checkSaved();
    vi.mocked(downloadPrebuilt).mockImplementation(options => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))));
    const pending = h.service.download(); await vi.waitFor(() => expect(downloadPrebuilt).toHaveBeenCalledOnce()); h.service.cancelDownload(); await pending;
    expect(h.states.get('msmarco')).toMatchObject({ phase: 'saved', savedAvailable: true }); await h.service.close();
  });
  it('waits for database operations before opening and abandons queued opens on shutdown', async () => {
    const h = marcoHarness(); h.states.setBusy(true); const pending = h.service.openSaved();
    await Promise.resolve(); expect(openPrebuilt).not.toHaveBeenCalled(); h.states.beginShutdown(); await pending; expect(openPrebuilt).not.toHaveBeenCalled(); await h.service.close();
  });
});
it('prevents a download from starting when the service closes during a storage check', async () => {
  const h = marcoHarness();
  let finish!: (value: { quota: number; usage: number }) => void;
  vi.mocked(navigator.storage.estimate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const downloading = h.service.download(); await vi.waitFor(() => expect(navigator.storage.estimate).toHaveBeenCalled());
  const closing = h.service.close(); finish({ quota: 10e9, usage: 0 }); await Promise.all([downloading, closing]);
  expect(downloadPrebuilt).not.toHaveBeenCalled(); await h.service.download(); expect(downloadPrebuilt).not.toHaveBeenCalled();
});
