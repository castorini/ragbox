import { openPrebuilt, PREBUILT_NAME } from '../prebuilt-msmarco.ts';
import { downloadPrebuilt } from '../download-prebuilt.ts';
import { errorMessage, errorName } from '../errors.ts';
import type { EvidenceDocument, RunTask } from '../types.ts';
import { ResourceStates, type ResourcePhase } from '../resource-state.ts';
import type { LoadCoordinator } from '../load-coordinator.ts';
import { retrieveMSMarco } from '../collection-retrieval.ts';

export function normalizeMSMarcoResults<T extends { id: string | number | bigint; contents?: string | null }>(rows: T[]): EvidenceDocument[] {
  return rows.map(row => ({
    id: `MARCO-${String(row.id)}`,
    title: `Passage ${String(row.id)}`,
    text: String(row.contents ?? ''),
  }));
}

export function createMSMarcoService(run: RunTask = task => task(), onState?: (phase: ResourcePhase, message: string, progress?: number, savedAvailable?: boolean) => void, loads?: LoadCoordinator, gate = new ResourceStates()) {
  const downloadUrl = import.meta.env.VITE_MSMARCO_INDEX_URL ||
    'https://huggingface.co/datasets/DavidzzzZZZ/msmarco-duckdb-fts/resolve/d8b39bc9edc94a16fb77359243163ed80c609c84/msmarco-prebuilt.duckdb';
  const downloadBytes = 3346542592;
  let prebuilt: Awaited<ReturnType<typeof openPrebuilt>> | undefined;
  let busy = false;
  let checkingSaved = true;
  let hasSaved: boolean | undefined;
  let openingQueued = false;
  let checkingPromise: Promise<void> | undefined;
  const unblockWaiters = new Set<() => void>();
  let pendingDownload: Promise<unknown> | undefined;
  let downloadController: AbortController | undefined;
  const supported = Boolean(globalThis.isSecureContext && navigator.storage?.getDirectory);
  function report(phase: ResourcePhase, message: string, percent?: number) {
    onState?.(phase, message, percent, hasSaved);
  }
  async function action<T>(task: () => Promise<T>, lockDatabase = true, searching = false): Promise<T | undefined> {
    if (busy || gate.busy || !supported || gate.shuttingDown) return;
    busy = true;
    try {
      const execute = async () => {
        try {
          return await task();
        } catch (error) {
          if (!prebuilt) {
            checkingSaved = false;
            if (errorName(error) === 'NotFoundError') hasSaved = false;
            report(errorName(error) === 'NotFoundError' ? 'missing' : 'error',
              errorName(error) === 'NotFoundError'
                ? 'No saved index. Download the index first.'
                : `Unable to complete the request: ${errorMessage(error)}`);
          }
          console.error(error);
          throw error;
        }
      };
      return await (lockDatabase ? run(execute, searching ? 'msmarco' : undefined) : execute());
    } catch {
      return undefined;
    } finally {
      busy = false;
    }
  }
  async function closePrebuilt() {
    const previous = prebuilt;
    prebuilt = undefined;
    if (previous) await previous.close();
  }
  async function connectPrebuilt(coordinated = false) {
    prebuilt = await (coordinated && loads ? loads.run(openPrebuilt) : openPrebuilt());
    checkingSaved = false;
    hasSaved = true;
    report('ready', `Ready to search ${prebuilt.count.toLocaleString()} passages.`);
  }
  function download() {
    if (busy || gate.busy || gate.shuttingDown) return;
    pendingDownload = action(async () => {
      await closePrebuilt();
      const root = await navigator.storage.getDirectory();
      const estimate = await navigator.storage.estimate();
      if (estimate.quota != null && estimate.usage != null && estimate.quota - estimate.usage < downloadBytes) {
        throw new Error('Not enough available browser storage for this download.');
      }
      const controller = new AbortController();
      downloadController = controller;
      let lastUpdate = 0;
      try {
        report('downloading', 'Starting index download…');
        await downloadPrebuilt({ url: downloadUrl, bytes: downloadBytes,
          root, name: PREBUILT_NAME, signal: controller.signal,
          onProgress(received, total) {
            const now = performance.now();
            if (now - lastUpdate < 200 && received !== total) return;
            lastUpdate = now;
            const percent = received / total * 100;
            report('downloading', `Downloading index: ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB (${percent.toFixed(1)}%).`, percent);
          },
        });
        hasSaved = true;
        if (gate.shuttingDown) return;
        report('opening', 'Opening index…');
        await connectPrebuilt(true);
      } catch (error) {
        if (errorName(error) === 'AbortError') {
          report(hasSaved ? 'saved' : 'missing', hasSaved ? 'Download cancelled. Retry or open the saved index.' : 'Download cancelled. Retry downloading the index.');
          return;
        }
        throw error;
      } finally {
        downloadController = undefined;
      }
    }, false);
    return pendingDownload;
  }
  async function openSaved() {
    if (openingQueued || busy || !supported || gate.shuttingDown) return;
    openingQueued = true;
    report('opening', 'Opening index…');
    try {
      const open = async () => {
        while (gate.busy && !gate.shuttingDown) await new Promise<void>(resolve => unblockWaiters.add(resolve));
        if (gate.shuttingDown) return;
        return action(async () => {
          await closePrebuilt();
          await connectPrebuilt();
        });
      };
      return await (loads ? loads.run(open) : open());
    } finally {
      openingQueued = false;
    }
  }
  if (!supported) report('unsupported', 'File storage unavailable. Use desktop Chrome on HTTPS or localhost.');
  else onState?.('checking', 'Checking saved index…');
  async function checkSaved() {
    if (!supported || prebuilt) return;
    if (checkingPromise) return checkingPromise;
    checkingPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(PREBUILT_NAME);
        hasSaved = true;
        report('saved', 'Saved index available.');
      } catch (error) {
        hasSaved = errorName(error) === 'NotFoundError' ? false : undefined;
        report(errorName(error) === 'NotFoundError' ? 'missing' : 'error',
          errorName(error) === 'NotFoundError'
            ? 'Not downloaded.'
            : `Could not check saved index: ${errorMessage(error)}. Retry opening the index.`);
      } finally {
        checkingSaved = false;
      }
    })();
    try { await checkingPromise; } finally { checkingPromise = undefined; }
  }
  const unsubscribe = gate.watch(state => [state.busy, state.shuttingDown], () => {
    if (!gate.busy || gate.shuttingDown) {
      for (const resolve of unblockWaiters) resolve();
      unblockWaiters.clear();
    }
  });
  return {
    download,
    async retrieve(query: string) {
      if (!prebuilt || busy || gate.busy || openingQueued || gate.shuttingDown) throw new Error('MS MARCO is not ready to search.');
      const index = prebuilt;
      const result = await action(() => retrieveMSMarco(index.conn, query), true, true);
      if (!result) throw new Error('MS MARCO search failed. Retry the question.');
      return result;
    },
    openSaved,
    cancelDownload() { downloadController?.abort(); },
    checkSaved,
    async reopenSaved() {
      if (!supported) return;
      if (checkingSaved) await checkSaved();
      if (!hasSaved || prebuilt) return;
      await openSaved();
    },
    setBlocked(value: boolean) { gate.setBusy(value); },
    async close() {
      downloadController?.abort();
      await pendingDownload;
      unsubscribe();
      await closePrebuilt();
      report('saved', 'Saved index available.');
    },
  };
}
