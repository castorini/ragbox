import { afterEach, expect, it, vi } from 'vitest';
import { deleteDemoFile, deleteDemoFiles } from '../src/reset.ts';
import { formatBytes, listStoredFiles, setupStorageDashboard } from '../src/storage-dashboard.ts';
import { ResourceStates } from '../src/resource-state.ts';
import { fakeElement, FakeElements } from './fake-elements.ts';

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
  const root = directory({ cache });
  await deleteDemoFiles(root);
  expect(vi.mocked(root.removeEntry).mock.calls.map(call => call[0])).toEqual([
    'analytics.duckdb.wal', 'analytics.duckdb.wal.checkpoint', 'analytics.duckdb.wal.recovery',
    'analytics.duckdb', 'msmarco-prebuilt.duckdb',
  ]);
  expect(cache.removeEntry).toHaveBeenCalledExactlyOnceWith('monthly_totals.parquet');
});

function harness(shutdown = vi.fn(async () => {}), root = directory({ 'analytics.duckdb': 2048, 'personal.txt': 1 })) {
  const elements = new FakeElements();
  vi.stubGlobal('document', {
    querySelector: (id: string) => elements.get(id),
    createElement: (tag: string) => Object.assign(fakeElement(tag), { setAttribute: vi.fn() }),
  });
  const confirm = vi.fn(() => true);
  const reload = vi.fn();
  vi.stubGlobal('window', { isSecureContext: true, confirm, location: { reload } });
  const getDirectory = vi.fn(async () => root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  const states = new ResourceStates();
  const dashboard = setupStorageDashboard(states, shutdown);
  return { root, elements, states, dashboard, shutdown, confirm, reload, getDirectory };
}

async function ready(ui: ReturnType<typeof harness>) {
  await vi.waitFor(() => {
    expect(ui.elements.get('#storage-summary').textContent).not.toBe('');
    expect(ui.elements.get('#storage-refresh').disabled).toBe(false);
  });
  ui.dashboard.initialized();
  ui.states.set('nfcorpus', 'ready', '');
  ui.states.set('msmarco', 'missing', '');
  ui.states.set('model', 'idle', '');
}

function modelCache(files: Record<string, number | null> = { 'model.onnx': 1024 }) {
  const responses = new Map(Object.entries(files).map(([name, size]) => [
    new Request(`https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX/resolve/main/${name}`),
    new Response(null, size === null ? undefined : { headers: { 'content-length': String(size) } }),
  ]));
  const cache = {
    keys: vi.fn(async () => [...responses.keys()]),
    match: vi.fn(async (request: Request) => responses.get(request)),
  };
  const storage = {
    keys: vi.fn(async () => ['transformers-cache']),
    open: vi.fn(async () => cache),
  };
  vi.stubGlobal('caches', storage);
  return { cache, storage };
}

it('uses summaries and file listings without redundant success messages', async () => {
  modelCache();
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false));
  expect(ui.elements.get('#storage-summary').textContent).toBe('1 app file · 2.0 KB');
  expect(ui.elements.get('#storage-usage').textContent).toBe('2.0 KB');
  expect(ui.elements.get('#storage-files').children).toHaveLength(2);
  expect(ui.elements.get('#model-cache-summary').textContent).toBe('1 cached file · 1.0 KB');
  expect(ui.elements.get('#model-storage-usage').textContent).toBe('1.0 KB');
  expect(ui.elements.get('#model-cache-files').children).toHaveLength(1);
  for (const id of ['#storage-status', '#model-cache-status']) {
    expect(ui.elements.get(id).hidden).toBe(true);
    expect(ui.elements.get(id).textContent).toBe('');
  }
});

it('shows concise empty states for both file listings', async () => {
  modelCache({});
  const ui = harness(undefined, directory());
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false));
  expect(ui.elements.get('#storage-summary').textContent).toBe('0 app files · 0 B');
  expect(ui.elements.get('#model-cache-summary').textContent).toBe('0 cached files · 0 B');
  expect(ui.elements.get('#storage-status').textContent).toBe('No files saved.');
  expect(ui.elements.get('#model-cache-status').textContent).toBe('No model files saved.');
  expect(ui.elements.get('#storage-status').hidden).toBe(false);
  expect(ui.elements.get('#model-cache-status').hidden).toBe(false);
  expect(ui.elements.get('#storage-files').children).toHaveLength(0);
  expect(ui.elements.get('#model-cache-files').children).toHaveLength(0);
});

it('refreshes visible storage totals after collection setup and excludes unrelated files', async () => {
  const ui = harness();
  await ready(ui);
  ui.getDirectory.mockResolvedValue(directory({ 'analytics.duckdb': 4096, 'msmarco-prebuilt.duckdb': 1024, 'personal.txt': 50_000 }));
  ui.states.set('msmarco', 'downloading', 'Downloading…');
  ui.states.set('msmarco', 'opening', 'Opening…');
  ui.states.set('msmarco', 'ready', 'Ready');
  await vi.waitFor(() => expect(ui.elements.get('#storage-usage').textContent).toBe('5.0 KB'));
  expect(ui.elements.get('#storage-summary').textContent).toBe('2 app files · 5.0 KB');
  expect(ui.elements.get('#storage-files').children).toHaveLength(3);
});

it('keeps unknown model sizes visible and excludes them from the known-size total', async () => {
  modelCache({ 'model.onnx': 1024, 'config.json': null });
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false));
  expect(ui.elements.get('#model-cache-summary').textContent).toBe('2 cached files · at least 1.0 KB');
  expect(ui.elements.get('#model-storage-usage').textContent).toBe('At least 1.0 KB');
  expect(ui.elements.get('#model-cache-files').children[0].children[1].textContent).toBe('Unknown');
  expect(ui.elements.get('#model-cache-status').textContent).toBe('Some file sizes are unknown.');
  expect(ui.elements.get('#model-cache-status').hidden).toBe(false);
});

it('reveals refresh errors after hidden success messages and hides them after recovery', async () => {
  const { storage } = modelCache();
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-status').hidden).toBe(true));
  ui.getDirectory.mockRejectedValueOnce(new Error('Collection read failed'));
  storage.keys.mockRejectedValueOnce(new Error('Cache read failed'));
  await ui.dashboard.refresh();
  expect(ui.elements.get('#storage-status').textContent).toContain('Collection read failed');
  expect(ui.elements.get('#model-cache-status').textContent).toContain('Cache read failed');
  expect(ui.elements.get('#storage-status').hidden).toBe(false);
  expect(ui.elements.get('#model-cache-status').hidden).toBe(false);
  await ui.dashboard.refresh();
  expect(ui.elements.get('#storage-status').hidden).toBe(true);
  expect(ui.elements.get('#model-cache-status').hidden).toBe(true);
});

it('refreshes each listing independently, showing loading and blocking duplicate refreshes', async () => {
  const { storage } = modelCache();
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false));
  const collectionReads = ui.getDirectory.mock.calls.length;
  const modelReads = storage.keys.mock.calls.length;
  let finishCollection!: (root: FileSystemDirectoryHandle) => void;
  let finishModel!: (names: string[]) => void;
  ui.getDirectory.mockImplementationOnce(() => new Promise(resolve => { finishCollection = resolve; }));
  storage.keys.mockImplementationOnce(() => new Promise(resolve => { finishModel = resolve; }));
  ui.elements.get('#storage-refresh').onclick();
  expect(ui.elements.get('#storage-refresh').disabled).toBe(true);
  expect(ui.elements.get('#storage-status').hidden).toBe(false);
  expect(ui.elements.get('#storage-status').textContent).toContain('Reading');
  expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false);
  expect(storage.keys).toHaveBeenCalledTimes(modelReads);
  ui.elements.get('#storage-refresh').onclick();
  expect(ui.getDirectory).toHaveBeenCalledTimes(collectionReads + 1);
  ui.elements.get('#model-cache-refresh').onclick();
  expect(ui.elements.get('#model-cache-refresh').disabled).toBe(true);
  expect(ui.elements.get('#model-cache-status').hidden).toBe(false);
  expect(ui.elements.get('#model-cache-status').textContent).toContain('Reading');
  expect(ui.getDirectory).toHaveBeenCalledTimes(collectionReads + 1);
  ui.elements.get('#model-cache-refresh').onclick();
  expect(storage.keys).toHaveBeenCalledTimes(modelReads + 1);
  finishCollection(ui.root);
  finishModel(['transformers-cache']);
  await vi.waitFor(() => {
    expect(ui.elements.get('#storage-refresh').disabled).toBe(false);
    expect(ui.elements.get('#model-cache-refresh').disabled).toBe(false);
  });
  expect(ui.elements.get('#storage-status').hidden).toBe(true);
  expect(ui.elements.get('#model-cache-status').hidden).toBe(true);
});

it('blocks deletion during active work and leaves storage alone when confirmation is cancelled', async () => {
  const ui = harness();
  await ready(ui);
  expect(ui.elements.get('#storage-reset').disabled).toBe(false);
  ui.states.setBusy(true);
  ui.elements.get('#storage-reset').onclick();
  expect(ui.confirm).not.toHaveBeenCalled();
  ui.states.setBusy(false);
  ui.confirm.mockReturnValue(false);
  ui.elements.get('#storage-reset').onclick();
  expect(ui.shutdown).not.toHaveBeenCalled();
  expect(ui.root.removeEntry).not.toHaveBeenCalled();
});

it('closes databases before deleting a database and its WAL, then reloads', async () => {
  const ui = harness();
  await ready(ui);
  const row = ui.elements.get('#storage-files').children[0];
  row.children[2].children[0].onclick();
  await vi.waitFor(() => expect(ui.reload).toHaveBeenCalledOnce());
  expect(ui.shutdown.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ui.root.removeEntry).mock.invocationCallOrder[0]);
  expect(vi.mocked(ui.root.removeEntry).mock.calls.map(call => call[0])).toEqual([
    'analytics.duckdb.wal', 'analytics.duckdb.wal.checkpoint', 'analytics.duckdb.wal.recovery', 'analytics.duckdb',
  ]);
  expect(ui.elements.get('#storage-files').children[1].children[2].textContent).toBe('Other origin file');
});

it('reports a shutdown failure without deleting files and allows reloading to recover', async () => {
  const ui = harness(vi.fn(async () => { throw new Error('File locked'); }));
  await ready(ui);
  ui.elements.get('#storage-reset').onclick();
  await vi.waitFor(() => expect(ui.elements.get('#storage-status').textContent).toContain('File locked'));
  expect(ui.elements.get('#storage-status').hidden).toBe(false);
  expect(ui.root.removeEntry).not.toHaveBeenCalled();
  expect(ui.elements.get('#storage-reset').disabled).toBe(true);
  expect(ui.elements.get('#storage-reload').disabled).toBe(false);
  ui.elements.get('#storage-reload').onclick();
  expect(ui.reload).toHaveBeenCalledOnce();
});

it('deletes installed model data after shutdown while preserving collection files', async () => {
  const url = 'https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX/resolve/main/model.onnx';
  const cache = {
    keys: vi.fn(async () => [new Request(url)]),
    match: vi.fn(async () => new Response(null, { headers: { 'content-length': '1840000000' } })),
    delete: vi.fn(async (_request: Request) => true),
  };
  vi.stubGlobal('caches', { keys: async () => ['transformers-cache'], open: async () => cache });
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#model-cache-delete').disabled).toBe(false));
  ui.states.set('model', 'loading', '');
  expect(ui.elements.get('#model-cache-delete').disabled).toBe(true);
  ui.elements.get('#model-cache-delete').onclick();
  expect(ui.confirm).not.toHaveBeenCalled();
  ui.states.set('model', 'ready', '');
  ui.confirm.mockReturnValue(false);
  ui.elements.get('#model-cache-delete').onclick();
  expect(ui.shutdown).not.toHaveBeenCalled();
  ui.confirm.mockReturnValue(true);
  ui.elements.get('#model-cache-delete').onclick();
  await vi.waitFor(() => expect(ui.reload).toHaveBeenCalledOnce());
  expect(ui.shutdown.mock.invocationCallOrder[0]).toBeLessThan(cache.delete.mock.invocationCallOrder[0]);
  expect(ui.root.removeEntry).not.toHaveBeenCalled();
});

it('resets collections and model cache together after confirmation and shutdown', async () => {
  const url = 'https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX/resolve/main/model.onnx';
  const other = 'https://example.com/unrelated.bin';
  const cache = {
    keys: vi.fn(async () => [new Request(url), new Request(other)]),
    match: vi.fn(async () => new Response(null)),
    delete: vi.fn(async (_request: Request) => true),
  };
  vi.stubGlobal('caches', { keys: async () => ['transformers-cache'], open: async () => cache });
  const ui = harness();
  await ready(ui);
  await vi.waitFor(() => expect(ui.elements.get('#storage-reset-all').disabled).toBe(false));
  ui.states.setBusy(true);
  ui.elements.get('#storage-reset-all').onclick();
  expect(ui.confirm).not.toHaveBeenCalled();
  ui.states.setBusy(false);
  ui.confirm.mockReturnValue(false);
  ui.elements.get('#storage-reset-all').onclick();
  expect(ui.shutdown).not.toHaveBeenCalled();
  ui.confirm.mockReturnValue(true);
  ui.elements.get('#storage-reset-all').onclick();
  await vi.waitFor(() => expect(ui.reload).toHaveBeenCalledOnce());
  expect(ui.confirm).toHaveBeenLastCalledWith(expect.stringContaining('all cached MiniCPM5-2B model files'));
  expect(ui.shutdown.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ui.root.removeEntry).mock.invocationCallOrder[0]);
  expect(ui.shutdown.mock.invocationCallOrder[0]).toBeLessThan(cache.delete.mock.invocationCallOrder[0]);
  expect(ui.root.removeEntry).toHaveBeenCalledWith('analytics.duckdb');
  expect(ui.root.removeEntry).toHaveBeenCalledWith('msmarco-prebuilt.duckdb');
  expect(ui.root.removeEntry).not.toHaveBeenCalledWith('personal.txt');
  expect(cache.delete).toHaveBeenCalledOnce();
  expect(cache.delete.mock.calls[0][0].url).toBe(url);
});

it('keeps reset all disabled when model cache management is unavailable', async () => {
  vi.stubGlobal('caches', undefined);
  const ui = harness();
  await ready(ui);
  expect(ui.elements.get('#storage-reset-all').disabled).toBe(true);
  ui.elements.get('#storage-reset-all').onclick();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(ui.shutdown).not.toHaveBeenCalled();
});
