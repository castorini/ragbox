import { openLocalDatabase } from './open-local-database.ts';
import { setupSearchGuidance } from './search-guidance.ts';
import { setupCollectionChooser } from './collection-chooser.ts';
import * as duckdb from '@duckdb/duckdb-wasm';
import { setupNFCorpus } from './nfcorpus.ts';
import { setupMSMarco } from './msmarco.ts';
import { setupLLM } from './llm-controller.ts';
import { errorMessage, requiredElement } from './boundaries.ts';
import type { Corpus, RunTask } from './types.ts';
import { ResourceStates } from './resource-state.ts';
import { LoadCoordinator } from './load-coordinator.ts';
import { setupStorageDashboard } from './storage-dashboard.ts';
import { setupCorpusDashboard } from './corpus-dashboard.ts';
import { setupSettingsView } from './settings-view.ts';
import { SearchHistory, setupHistoryView } from './history.ts';

const status = requiredElement<HTMLElement>('#status');
const states = new ResourceStates();
const loads = new LoadCoordinator();
const history = new SearchHistory();
setupHistoryView(history);
let db: duckdb.AsyncDuckDB | undefined;
let busy = false;
let marco: ReturnType<typeof setupMSMarco> | undefined;
let nfcorpus: ReturnType<typeof setupNFCorpus> | undefined;
let activeCorpus: Corpus = 'nfcorpus';
const chooser = setupCollectionChooser(value => {
  if (value !== activeCorpus) llm.invalidateSearch();
  activeCorpus = value;
  dashboard.render();
  if (value === 'msmarco') void marco?.reopenSaved();
}, () => llm.resetAnswers());
const setupActions = {
  prepare: () => nfcorpus?.prepare(),
  download: () => marco?.download(),
  openSaved: () => marco?.openSaved(),
  cancelDownload: () => marco?.cancelDownload(),
};
setupSearchGuidance(states, setupActions);
const dashboard = setupCorpusDashboard(states, chooser, setupActions);
setupSettingsView(states, chooser);

const run: RunTask = async (action, searchCorpus) => {
  if (busy) return;
  busy = true;
  states.setBusy(true, searchCorpus);
  marco?.setBlocked(true);
  nfcorpus?.setBlocked(true);
  try {
    return await action();
  } catch (error) {
    status.textContent = `Error: ${errorMessage(error)}`;
    console.error(error);
  } finally {
    busy = false;
    marco?.setBlocked(false);
    nfcorpus?.setBlocked(false);
    states.setBusy(false);
  }
};

const llm = setupLLM((phase, message, model) => states.set('model', phase, message, model), loads);
const capability = llm.initializeCapability();
let conn: duckdb.AsyncDuckDBConnection | undefined;
const storage = setupStorageDashboard(states, async () => {
  busy = true;
  states.setBusy(true);
  marco?.setBlocked(true);
  nfcorpus?.setBlocked(true);
  requiredElement<HTMLButtonElement>('#llm-load').disabled = true;
  llm.dispose();
  await loads.run(async () => {
    await marco?.close();
    if (conn) {
      await conn.query('CHECKPOINT');
      await conn.close();
      conn = undefined;
    }
    await db?.terminate();
    db = undefined;
  });
}, () => { void llm.refreshCache(); });
llm.setOnLoadSettled(() => { void storage.refresh(); });

async function main() {
  if (!window.isSecureContext || !navigator.storage?.getDirectory) {
    states.set('nfcorpus', 'unsupported', 'OPFS is unavailable in this browser.');
    states.set('msmarco', 'unsupported', 'OPFS is unavailable in this browser.');
    throw new Error('OPFS requires a supported browser on localhost or HTTPS');
  }
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([
    `importScripts(${JSON.stringify(bundle.mainWorker)});`
  ], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
  await openLocalDatabase(db, await navigator.storage.getDirectory());
  conn = await db.connect();
  nfcorpus = setupNFCorpus(db, conn, run, llm,
    (phase, message) => states.set('nfcorpus', phase, message), loads, history);
  marco = setupMSMarco(run, llm,
    (phase, message, progress, savedAvailable) => states.set('msmarco', phase, message, undefined, progress, savedAvailable), loads, history);
  status.textContent = 'Ready.';
  await loads.run(() => nfcorpus!.reopenSaved());
  await marco.checkSaved();
  if (chooser.selected() === 'msmarco') void marco.reopenSaved();
  if ((await capability).supported && llm.model.cache === 'installed') {
    void llm.loadAndWait(true).catch(console.error);
  }
}
main().catch(async error => {
  status.textContent = `Startup failed: ${errorMessage(error)}`;
  status.hidden = false;
  if (states.get('nfcorpus').phase !== 'unsupported') states.set('nfcorpus', 'error', status.textContent);
  if (states.get('msmarco').phase !== 'unsupported') states.set('msmarco', 'error', status.textContent);
  console.error(error);
  if (db) await db.terminate().catch(console.error);
  db = undefined;
  conn = undefined;
}).finally(() => {
  storage.initialized();
  void storage.refresh();
});
