import { afterEach, expect, it, vi } from 'vitest';
import { deleteDemoFile, deleteDemoFiles } from '../src/reset.ts';
import { listStoredFiles, StorageService, removalDescription } from '../src/services/storage.ts';
import { formatBytes } from '../src/format.ts';
import { MODEL_ID } from '../src/model-cache.ts';
import { ResourceStates } from '../src/resource-state.ts';

function directory(entries: Record<string, number | FileSystemDirectoryHandle> = {}) {
  return {
    kind: 'directory',
    async *entries() {
      for (const [name, value] of Object.entries(entries)) yield [name,
        typeof value === 'number' ? { kind: 'file', getFile: async () => ({ size: value }) } : value];
    },
    getDirectoryHandle: vi.fn(async (name: string) => {
      const value = entries[name];
      if (typeof value === 'object') return value;
      throw new DOMException('Missing', 'NotFoundError');
    }),
    removeEntry: vi.fn(async (name: string) => { delete entries[name]; }),
  } as unknown as FileSystemDirectoryHandle;
}

afterEach(() => vi.unstubAllGlobals());

it('lists nested files with sizes and ownership without treating unrelated files as deletable', async () => {
  const root = directory({ 'analytics.duckdb': 2048, cache: directory({ 'monthly_totals.parquet': 100, 'personal.txt': 7 }) });
  expect(await listStoredFiles(root)).toEqual([
    { path: 'analytics.duckdb', size: 2048, owned: true },
    { path: 'cache/monthly_totals.parquet', size: 100, owned: true },
    { path: 'cache/personal.txt', size: 7, owned: false },
  ]);
  expect(formatBytes(2048)).toBe('2.0 KB');
  expect(formatBytes(3346542592)).toBe('3.1 GB');
});

it('rejects arbitrary deletion paths and tolerates files already missing', async () => {
  const root = directory();
  await expect(deleteDemoFile(root, 'personal.txt')).rejects.toThrow('not owned');
  expect(root.removeEntry).not.toHaveBeenCalled();
  vi.mocked(root.removeEntry).mockRejectedValue(new DOMException('Missing', 'NotFoundError'));
  await expect(deleteDemoFile(root, 'analytics.duckdb')).resolves.toBeUndefined();
  vi.mocked(root.removeEntry).mockRejectedValue(new DOMException('Locked', 'NoModificationAllowedError'));
  await expect(deleteDemoFile(root, 'analytics.duckdb')).rejects.toThrow('Locked');
});

it('resets only known files, removes WAL before the database, and keeps directories', async () => {
  const cache = directory({ 'personal.txt': 1 });
  const root = directory({ 'msmarco-prebuilt.duckdb': 2048, 'msmarco-prebuilt.duckdb.wal': 512, 'personal.txt': 1, cache });
  await deleteDemoFiles(root);
  expect(vi.mocked(root.removeEntry).mock.calls.map(call => call[0])).toEqual([
    'analytics.duckdb.wal', 'analytics.duckdb.wal.checkpoint', 'analytics.duckdb.wal.recovery',
    'analytics.duckdb', 'msmarco-prebuilt.duckdb.wal', 'msmarco-prebuilt.duckdb',
  ]);
  expect(cache.removeEntry).toHaveBeenCalledExactlyOnceWith('monthly_totals.parquet');
  expect(await listStoredFiles(root)).toEqual([
    { path: 'cache/personal.txt', size: 1, owned: false },
    { path: 'personal.txt', size: 1, owned: false },
  ]);
});

function storageHarness(shutdown = vi.fn(async () => {}), root = directory({ 'analytics.duckdb': 2048, 'personal.txt': 1 })) {
  vi.stubGlobal('isSecureContext', true);
  const getDirectory = vi.fn().mockResolvedValue(root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  const requests = [{ url: `https://huggingface.co/${MODEL_ID}/resolve/pin/model.onnx` }, { url: 'https://example.com/unrelated' }];
  const cache = { keys: vi.fn(async () => requests), match: vi.fn(async () => new Response('', { headers: { 'content-length': '4096' } })), delete: vi.fn(async (_request: unknown) => true) };
  vi.stubGlobal('caches', { keys: vi.fn(async () => ['transformers-cache']), open: vi.fn(async () => cache) });
  const resources = new ResourceStates(); resources.set('nfcorpus', 'missing', 'Not prepared'); resources.set('msmarco', 'missing', 'Not downloaded'); resources.set('model', 'idle', 'Not loaded');
  const reload = vi.fn(), changed = vi.fn();
  const service = new StorageService(resources, shutdown, changed, reload);
  return { service, root, getDirectory, cache, resources, shutdown, reload, changed };
}
it('loads owned totals and model listings independently without reading weight bodies', async () => {
  const h = storageHarness(); await h.service.initialize();
  expect(h.service.state.getState()).toMatchObject({ initialized: true, refreshing: false, refreshingModel: false, message: '', modelMessage: '' });
  expect(h.service.state.getState().modelFiles).toEqual([expect.objectContaining({ size: 4096, path: 'resolve/pin/model.onnx' })]); expect(h.changed).toHaveBeenCalledOnce(); h.service.dispose();
});
it('keeps unknown sizes visible and does not invent model byte totals', async () => {
  const h = storageHarness(); h.cache.match.mockResolvedValue(new Response(''));
  await h.service.initialize(); expect(h.service.state.getState().modelFiles[0].size).toBeNull(); expect(h.service.state.getState().modelMessage).toContain('Some file sizes are unknown'); h.service.dispose();
});
it('reports refresh failures and clears them after a successful retry', async () => {
  const h = storageHarness(); h.getDirectory.mockRejectedValueOnce(new Error('Storage blocked')); await h.service.initialize();
  expect(h.service.state.getState().message).toContain('Storage blocked'); await h.service.refreshCollections(); expect(h.service.state.getState().message).toBe(''); h.service.dispose();
});
it('deduplicates refreshes without blocking the other file listing', async () => {
  const h = storageHarness(); let finish!: (root: FileSystemDirectoryHandle) => void;
  h.getDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.service.refreshCollections(); await h.service.refreshCollections(); await h.service.refreshModels();
  expect(h.getDirectory).toHaveBeenCalledOnce(); expect(h.service.state.getState().modelFiles).toHaveLength(1); expect(h.service.state.getState().refreshing).toBe(true);
  finish(h.root); await pending; expect(h.service.state.getState().refreshing).toBe(false); h.service.dispose();
});
it('refreshes collection files after resource setup completes', async () => {
  const h = storageHarness(); await h.service.initialize(); h.getDirectory.mockClear();
  h.resources.set('nfcorpus', 'preparing', 'Building index'); h.resources.set('nfcorpus', 'ready', 'Ready');
  await vi.waitFor(() => expect(h.getDirectory).toHaveBeenCalledOnce()); h.service.dispose();
});
it('blocks deletion during initialization, generation, preparation or active file reads', async () => {
  const h = storageHarness(); await h.service.remove({ kind: 'collections' }); expect(h.shutdown).not.toHaveBeenCalled(); await h.service.initialize();
  for (const phase of ['generating', 'loading'] as const) { h.resources.set('model', phase, 'Busy'); await h.service.remove({ kind: 'collections' }); expect(h.shutdown).not.toHaveBeenCalled(); }
  h.service.dispose();
});
it('rejects unrelated paths before stopping the runtime', async () => {
  const h = storageHarness(); await h.service.initialize(); await expect(h.service.remove({ kind: 'file', path: 'personal.txt' })).rejects.toThrow('RAGbox-owned'); expect(h.shutdown).not.toHaveBeenCalled(); h.service.dispose();
});
it('waits for shutdown before deleting a database and its WAL, then reloads', async () => {
  let stopped!: () => void;
  const h = storageHarness(vi.fn(() => new Promise<void>(resolve => { stopped = resolve; }))); await h.service.initialize();
  const pending = h.service.remove({ kind: 'file', path: 'analytics.duckdb' }); expect(h.root.removeEntry).not.toHaveBeenCalled();
  stopped(); await pending;
  expect(vi.mocked(h.root.removeEntry).mock.calls.map(call => call[0])).toEqual(['analytics.duckdb.wal', 'analytics.duckdb.wal.checkpoint', 'analytics.duckdb.wal.recovery', 'analytics.duckdb']);
  expect(h.cache.delete).not.toHaveBeenCalled(); expect(h.reload).toHaveBeenCalledOnce(); h.service.dispose();
});
it('keeps all files when shutdown fails and exposes reload recovery', async () => {
  const h = storageHarness(vi.fn(async () => { throw new Error('Database still busy'); })); await h.service.initialize(); await h.service.remove({ kind: 'all' });
  expect(h.root.removeEntry).not.toHaveBeenCalled(); expect(h.cache.delete).not.toHaveBeenCalled(); expect(h.reload).not.toHaveBeenCalled();
  expect(h.service.state.getState()).toMatchObject({ recovery: true, stopped: true, deleting: false }); expect(h.service.state.getState().message).toContain('Database still busy'); h.service.dispose();
});
it('deletes only model cache entries after shutdown while keeping collections', async () => {
  const h = storageHarness(); await h.service.initialize(); await h.service.remove({ kind: 'model' });
  expect(h.shutdown).toHaveBeenCalledOnce(); expect(h.root.removeEntry).not.toHaveBeenCalled(); expect(h.cache.delete).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining(MODEL_ID) })); expect(h.cache.delete).toHaveBeenCalledOnce(); expect(h.reload).toHaveBeenCalledWith({ kind: 'model' }); h.service.dispose();
});
it('resets collections and model together while retaining unrelated origin data', async () => {
  const h = storageHarness(); await h.service.initialize(); await h.service.remove({ kind: 'all' });
  expect(h.root.removeEntry).not.toHaveBeenCalledWith('personal.txt'); expect(h.cache.delete).toHaveBeenCalledOnce(); expect(h.reload).toHaveBeenCalledOnce(); h.service.dispose();
});
it('describes the consequences of every deletion scope for the confirmation UI', () => {
  expect(removalDescription({ kind: 'model' })).toContain('Collection indexes are kept');
  expect(removalDescription({ kind: 'collections' })).toContain('The model cache is kept');
  expect(removalDescription({ kind: 'file', path: 'analytics.duckdb' })).toContain('analytics.duckdb');
  expect(removalDescription({ kind: 'all' })).toContain('prepare collections and download the model again');
});
