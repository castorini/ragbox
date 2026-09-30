import { setupSearchGuidance } from './search-guidance.ts';
import { setupCollectionChooser } from './collection-chooser.ts';
import * as duckdb from '@duckdb/duckdb-wasm';
import './style.css';
import { setupNFCorpus } from './nfcorpus.ts';
import { setupMSMarco } from './msmarco.ts';
import { setupLLM } from './llm-controller.ts';
import { errorMessage, requiredElement } from './boundaries.ts';
import type { RunTask } from './types.ts';
import { ResourceStates } from './resource-state.ts';
import { LoadCoordinator } from './load-coordinator.ts';

const status = requiredElement<HTMLElement>('#status');
const states = new ResourceStates();
const loads = new LoadCoordinator();
let db: duckdb.AsyncDuckDB | undefined;
let busy = false;
let marco: ReturnType<typeof setupMSMarco> | undefined;
let nfcorpus: ReturnType<typeof setupNFCorpus> | undefined;
const chooser = setupCollectionChooser(value => {
  if (value === 'msmarco') void marco?.reopenSaved();
});
setupSearchGuidance(states);

const run: RunTask = async action => {
  if (busy) return;
  busy = true;
  states.setBusy(true);
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

const llm = setupLLM((phase, message) => states.set('model', phase, message), loads);
const capability = llm.initializeCapability();

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
  await db.open({
    path: 'opfs://analytics.duckdb',
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
    opfs: { fileHandling: 'auto' },
  });
  const conn = await db.connect();
  nfcorpus = setupNFCorpus(db, conn, run, llm,
    (phase, message) => states.set('nfcorpus', phase, message), loads);
  marco = setupMSMarco(run, llm,
    (phase, message) => states.set('msmarco', phase, message), loads);
  status.textContent = 'Ready.';
  await loads.run(() => nfcorpus!.reopenSaved());
  await marco.checkSaved();
  if (chooser.selected() === 'msmarco') void marco.reopenSaved();
  if ((await capability).supported) {
    void loads.run(() => llm.loadAndWait(true)).catch(console.error);
  }
}
main().catch(async error => {
  status.textContent = `Startup failed: ${errorMessage(error)}`;
  status.hidden = false;
  if (states.get('nfcorpus').phase !== 'unsupported') states.set('nfcorpus', 'error', status.textContent);
  if (states.get('msmarco').phase !== 'unsupported') states.set('msmarco', 'error', status.textContent);
  console.error(error);
  if (db) await db.terminate().catch(console.error);
});
