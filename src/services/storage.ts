import { createStore } from 'zustand/vanilla';
import { errorMessage } from '../errors.ts';
import { DEMO_FILES, deleteDemoFile, deleteDemoFiles } from '../reset.ts';
import { deleteModelCacheFiles, listModelCacheFiles, type ModelCacheFile } from '../model-cache.ts';
import type { ResourceStates } from '../resource-state.ts';

export interface StoredFile { path: string; size: number; owned: boolean }
export type StorageTarget = { kind: 'file'; path: string } | { kind: 'collections' | 'all' | 'model' };
export interface StorageSnapshot {
  files: StoredFile[]; modelFiles: ModelCacheFile[];
  refreshing: boolean; refreshingModel: boolean; deleting: boolean; stopped: boolean;
  initialized: boolean; recovery: boolean; message: string; modelMessage: string;
  supported: boolean; cacheSupported: boolean;
}
export async function listStoredFiles(root: FileSystemDirectoryHandle): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, `${path}/`);
      else files.push({ path, size: (await (handle as FileSystemFileHandle).getFile()).size, owned: DEMO_FILES.some(name => name === path) });
    }
  }
  await visit(root, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function removalDescription(target: StorageTarget) {
  if (target.kind === 'model') return 'Delete all cached MiniCPM5-2B model files? The local model will stop and the page will reload. Collection indexes are kept. Close other RAGbox tabs first.';
  const message = target.kind === 'all'
    ? 'Reset all RAGbox data? Saved collection databases, indexes, demo Parquet files, and all cached MiniCPM5-2B model files will be deleted. You will need to prepare collections and download the model again.'
    : target.kind === 'file' ? `Delete ${target.path}? Deleting a database removes its collection and index.`
      : 'Reset all RAGbox collection data? Saved databases, indexes, and demo Parquet files will be deleted.';
  return `${message} The page will reload.${target.kind === 'all' ? '' : ' The model cache is kept.'} Close other RAGbox tabs first.`;
}
const activePhases = new Set(['checking', 'opening', 'preparing', 'downloading', 'loading', 'generating']);
export class StorageService {
  readonly state;
  private unsubscribe: () => void;
  constructor(private resources: ResourceStates, private shutdown: () => Promise<void>,
    private onModelCacheChanged: () => void = () => {},
    private reload: (target?: StorageTarget) => void = target => {
      if (target?.kind === 'model' && location.hash === '#model-storage') {
        const url = new URL(location.href); url.hash = 'model'; history.replaceState(null, '', url);
      }
      location.reload();
    }) {
    const supported = Boolean(globalThis.isSecureContext && globalThis.navigator?.storage?.getDirectory);
    const cacheSupported = Boolean(globalThis.isSecureContext && globalThis.caches);
    this.state = createStore<StorageSnapshot>(() => ({
      files: [], modelFiles: [], refreshing: false, refreshingModel: false, deleting: false, stopped: false,
      initialized: false, recovery: false, supported, cacheSupported,
      message: supported ? '' : 'File storage unavailable. Use a supported browser on HTTPS or localhost.',
      modelMessage: cacheSupported ? '' : 'Model cache unavailable. Use a supported browser on HTTPS or localhost.',
    }));
    let updating = false;
    this.unsubscribe = resources.watch(s => [s.resources.nfcorpus.phase, s.resources.msmarco.phase], () => {
      const next = (['nfcorpus', 'msmarco'] as const).some(name => ['preparing', 'downloading', 'opening'].includes(resources.get(name).phase));
      const finished = updating && !next; updating = next;
      if (finished && !this.state.getState().stopped) void this.refreshCollections();
    });
  }
  blocked() {
    const s = this.state.getState();
    return !s.initialized || s.deleting || s.stopped || s.refreshing || s.refreshingModel || this.resources.busy ||
      (['nfcorpus', 'msmarco', 'model'] as const).some(name => activePhases.has(this.resources.get(name).phase));
  }
  async refreshCollections() {
    const s = this.state.getState();
    if (!s.supported || s.refreshing || s.deleting || s.stopped) return;
    this.state.setState({ refreshing: true, message: 'Reading collection files…' });
    try {
      const files = await listStoredFiles(await navigator.storage.getDirectory());
      this.state.setState({ files, message: files.length ? '' : 'No files saved.' });
    } catch (error) { this.state.setState({ files: [], message: `Could not read browser files: ${errorMessage(error)}` }); }
    finally { this.state.setState({ refreshing: false }); }
  }
  async refreshModels() {
    const s = this.state.getState();
    if (!s.cacheSupported || s.refreshingModel || s.deleting || s.stopped) return;
    this.state.setState({ refreshingModel: true, modelMessage: 'Reading model files…' });
    try {
      const modelFiles = await listModelCacheFiles(caches);
      this.state.setState({ modelFiles, modelMessage: !modelFiles.length ? 'No model files saved.' : modelFiles.some(file => file.size === null) ? 'Some file sizes are unknown.' : '' });
    } catch (error) { this.state.setState({ modelFiles: [], modelMessage: `Could not read model cache: ${errorMessage(error)}` }); }
    finally { this.state.setState({ refreshingModel: false }); this.onModelCacheChanged(); }
  }
  async refresh() { await Promise.all([this.refreshCollections(), this.refreshModels()]); }
  async initialize() { this.state.setState({ initialized: true }); await this.refresh(); }
  // The caller presents confirmation. Recheck the operation gate after it is accepted.
  async remove(target: StorageTarget) {
    const s = this.state.getState();
    if (this.blocked() || (target.kind !== 'model' && !s.supported) || (['all', 'model'].includes(target.kind) && !s.cacheSupported)) return;
    if (target.kind === 'file' && !DEMO_FILES.some(path => path === target.path)) throw new Error('Only RAGbox-owned files can be deleted.');
    if (target.kind === 'model' && !s.modelFiles.length) return;
    const model = target.kind === 'model';
    this.state.setState({ deleting: true, stopped: true, [model ? 'modelMessage' : 'message']: model ? 'Deleting model files…' : 'Removing saved files…' });
    try {
      await this.shutdown();
      if (!model) {
        const root = await navigator.storage.getDirectory();
        if (target.kind === 'file') {
          if (target.path === 'analytics.duckdb' || target.path === 'msmarco-prebuilt.duckdb') {
            for (const path of DEMO_FILES.filter(path => path === target.path || path.startsWith(`${target.path}.wal`))) await deleteDemoFile(root, path);
          } else await deleteDemoFile(root, target.path);
        } else await deleteDemoFiles(root);
      }
      if (model || target.kind === 'all') await deleteModelCacheFiles(caches);
      this.reload(target);
    } catch (error) {
      this.state.setState({ recovery: true, [model ? 'modelMessage' : 'message']: `Could not ${model ? 'delete model data' : 'remove saved files'}: ${errorMessage(error)}. Close other RAGbox tabs and reload to retry.` });
    } finally { this.state.setState({ deleting: false }); }
  }
  reloadPage() { if (!this.state.getState().deleting) this.reload(); }
  dispose() { this.unsubscribe(); }
}
