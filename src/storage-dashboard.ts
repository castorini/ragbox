import { errorMessage, requiredElement } from './boundaries.ts';
import { DEMO_FILES, deleteDemoFile, deleteDemoFiles } from './reset.ts';
import type { ResourceStates } from './resource-state.ts';
import { deleteModelCacheFiles, listModelCacheFiles, type ModelCacheFile } from './model-cache.ts';

export interface StoredFile { path: string; size: number; owned: boolean }

export async function listStoredFiles(root: FileSystemDirectoryHandle): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, `${path}/`);
      else {
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({ path, size: file.size, owned: DEMO_FILES.some(name => name === path) });
      }
    }
  }
  await visit(root, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export { formatBytes } from './format.ts';
import { formatBytes } from './format.ts';

function showStatus(element: HTMLElement, message: string) {
  element.textContent = message;
  element.hidden = !message;
}

export function setupStorageDashboard(states: ResourceStates, shutdown: () => Promise<void>, onModelCacheChanged?: () => void) {
  const rows = requiredElement<HTMLTableSectionElement>('#storage-files');
  const status = requiredElement<HTMLElement>('#storage-status');
  const summary = requiredElement<HTMLElement>('#storage-summary');
  const usage = requiredElement<HTMLElement>('#storage-usage');
  const refreshButton = requiredElement<HTMLButtonElement>('#storage-refresh');
  const recovery = requiredElement<HTMLElement>('#storage-recovery');
  const reloadButton = requiredElement<HTMLButtonElement>('#storage-reload');
  recovery.hidden = true;
  const resetButton = requiredElement<HTMLButtonElement>('#storage-reset');
  const resetAllButton = requiredElement<HTMLButtonElement>('#storage-reset-all');
  const modelRows = requiredElement<HTMLTableSectionElement>('#model-cache-files');
  const modelStatus = requiredElement<HTMLElement>('#model-cache-status');
  const modelSummary = requiredElement<HTMLElement>('#model-cache-summary');
  const modelUsage = requiredElement<HTMLElement>('#model-storage-usage');
  const modelRefresh = requiredElement<HTMLButtonElement>('#model-cache-refresh');
  const modelDelete = requiredElement<HTMLButtonElement>('#model-cache-delete');
  const supported = Boolean(window.isSecureContext && navigator.storage?.getDirectory);
  const cacheSupported = Boolean(window.isSecureContext && globalThis.caches);
  let files: StoredFile[] = [];
  let modelFiles: ModelCacheFile[] = [];
  let refreshingModel = false;
  let refreshing = false;
  let deleting = false;
  let stopped = false;
  let initialized = false;
  const deleteButtons: HTMLButtonElement[] = [];
  const activePhases = new Set(['checking', 'opening', 'preparing', 'downloading', 'loading', 'generating']);
  function blocked() {
    return !initialized || deleting || stopped || refreshing || refreshingModel || states.busy ||
      (['nfcorpus', 'msmarco', 'model'] as const).some(name => activePhases.has(states.get(name).phase));
  }
  function updateControls() {
    refreshButton.disabled = !supported || refreshing || deleting;
    resetButton.disabled = !supported || blocked() || !files.some(file => file.owned);
    resetAllButton.disabled = !supported || !cacheSupported || blocked();
    for (const button of deleteButtons) button.disabled = !supported || blocked();
    modelRefresh.disabled = !cacheSupported || refreshingModel || deleting;
    modelDelete.disabled = !cacheSupported || blocked() || !modelFiles.length;
    reloadButton.disabled = deleting;
  }
  async function remove(path?: string, all = false) {
    if (!supported || (all && !cacheSupported) || blocked()) return;
    const message = all
      ? 'Reset all ragbox data? Saved collection databases, indexes, demo Parquet files, and all cached MiniCPM5-2B model files will be deleted. You will need to prepare collections and download the model again.'
      : path
      ? `Delete ${path}? Deleting a database removes its collection and index.`
      : 'Reset all ragbox collection data? Saved databases, indexes, and demo Parquet files will be deleted.';
    if (!window.confirm(`${message} The page will reload.${all ? '' : ' The model cache is kept.'} Close other ragbox tabs first.`)) return;
    deleting = true;
    updateControls();
    showStatus(status, all ? 'Removing all ragbox data…' : 'Removing saved files…');
    try {
      stopped = true;
      await shutdown();
      const root = await navigator.storage.getDirectory();
      // Database WAL files belong to the same database and must not survive its deletion.
      if (path === 'analytics.duckdb') {
        for (const name of DEMO_FILES.filter(name => name.startsWith('analytics.duckdb'))) await deleteDemoFile(root, name);
      } else if (path) await deleteDemoFile(root, path);
      else await deleteDemoFiles(root);
      if (all) await deleteModelCacheFiles(caches);
      window.location.reload();
    } catch (error) {
      showStatus(status, `Could not remove saved files: ${errorMessage(error)}. Close other ragbox tabs and reload to retry.`);
      recovery.hidden = false;
    } finally {
      deleting = false;
      updateControls();
    }
  }
  async function refreshModel() {
    if (!cacheSupported || refreshingModel || deleting) return;
    refreshingModel = true;
    updateControls();
    showStatus(modelStatus, 'Reading model files…');
    try {
      modelFiles = await listModelCacheFiles(caches);
      modelRows.replaceChildren();
      for (const file of modelFiles) {
        const row = document.createElement('tr');
        for (const text of [file.path, file.size === null ? 'Unknown' : formatBytes(file.size), file.cache]) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        modelRows.append(row);
      }
      const unknown = modelFiles.some(file => file.size === null);
      const total = modelFiles.reduce((sum, file) => sum + (file.size ?? 0), 0);
      modelSummary.textContent = `${modelFiles.length} cached file${modelFiles.length === 1 ? '' : 's'} · ${unknown ? 'at least ' : ''}${formatBytes(total)}`;
      modelUsage.textContent = `${unknown ? 'At least ' : ''}${formatBytes(total)}`;
      showStatus(modelStatus, modelFiles.length
        ? (unknown ? 'Some file sizes are unknown.' : '')
        : 'No model files saved.');
    } catch (error) {
      modelFiles = [];
      modelSummary.textContent = '';
      modelUsage.textContent = 'Unavailable';
      modelRows.replaceChildren();
      showStatus(modelStatus, `Could not read model cache: ${errorMessage(error)}`);
    } finally {
      refreshingModel = false;
      updateControls();
      onModelCacheChanged?.();
    }
  }
  async function removeModel() {
    if (!cacheSupported || blocked() || !modelFiles.length) return;
    if (!window.confirm('Delete all cached MiniCPM5-2B model files? The local model will stop and the page will reload. Collection indexes are kept. Close other ragbox tabs first.')) return;
    deleting = true;
    updateControls();
    showStatus(modelStatus, 'Deleting model files…');
    try {
      stopped = true;
      await shutdown();
      await deleteModelCacheFiles(caches);
      if (window.location.hash === '#model-storage') {
        // Reopen Settings at the model action after deletion.
        const url = new URL(window.location.href);
        url.hash = 'model';
        window.history.replaceState(null, '', url);
      }
      window.location.reload();
    } catch (error) {
      showStatus(modelStatus, `Could not delete model data: ${errorMessage(error)}. Reload to retry.`);
      recovery.hidden = false;
    } finally {
      deleting = false;
      updateControls();
    }
  }
  async function refresh() {
    if (!supported || refreshing || deleting) return;
    refreshing = true;
    updateControls();
    showStatus(status, 'Reading collection files…');
    try {
      const root = await navigator.storage.getDirectory();
      files = await listStoredFiles(root);
      rows.replaceChildren();
      deleteButtons.length = 0;
      for (const file of files) {
        const row = document.createElement('tr');
        for (const text of [file.path, formatBytes(file.size)]) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        const action = document.createElement('td');
        if (file.owned) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Delete';
          button.className = 'danger';
          button.setAttribute('aria-label', `Delete ${file.path}`);
          button.onclick = () => { void remove(file.path); };
          deleteButtons.push(button);
          action.append(button);
        } else action.textContent = 'Other origin file';
        row.append(action);
        rows.append(row);
      }
      const owned = files.filter(file => file.owned);
      const total = formatBytes(owned.reduce((total, file) => total + file.size, 0));
      summary.textContent = `${owned.length} app file${owned.length === 1 ? '' : 's'} · ${total}`;
      usage.textContent = total;
      showStatus(status, files.length ? '' : 'No files saved.');
    } catch (error) {
      files = [];
      rows.replaceChildren();
      deleteButtons.length = 0;
      summary.textContent = '';
      usage.textContent = 'Unavailable';
      showStatus(status, `Could not read browser files: ${errorMessage(error)}`);
    } finally {
      refreshing = false;
      updateControls();
    }
  }
  let collectionsUpdating = false;
  states.subscribe(() => {
    updateControls();
    const updating = (['nfcorpus', 'msmarco'] as const).some(name =>
      ['preparing', 'downloading', 'opening'].includes(states.get(name).phase));
    const finished = collectionsUpdating && !updating;
    collectionsUpdating = updating;
    if (finished && !stopped) void refresh();
  });
  refreshButton.onclick = () => { void refresh(); };
  reloadButton.onclick = () => { if (!deleting) window.location.reload(); };
  resetButton.onclick = () => { void remove(); };
  resetAllButton.onclick = () => { void remove(undefined, true); };
  modelRefresh.onclick = () => { void refreshModel(); };
  modelDelete.onclick = () => { void removeModel(); };
  if (!supported) {
    usage.textContent = 'Unavailable';
    showStatus(status, 'File storage unavailable. Use a supported browser on HTTPS or localhost.');
  }
  if (!cacheSupported) {
    modelUsage.textContent = 'Unavailable';
    showStatus(modelStatus, 'Model cache unavailable. Use a supported browser on HTTPS or localhost.');
  }
  void refresh();
  void refreshModel();
  return { refresh: async () => { await Promise.all([refresh(), refreshModel()]); }, initialized() { initialized = true; updateControls(); } };
}
