import { setupSearchGuidance } from './search-guidance.js';
import { setupCollectionChooser } from './collection-chooser.js';
import * as duckdb from '@duckdb/duckdb-wasm';
import './style.css';
import { setupNFCorpus } from './nfcorpus.js';
import { setupMSMarco } from './msmarco.js';
import { setupLLM } from './llm-controller.js';

setupCollectionChooser();
setupSearchGuidance();

const status = document.querySelector('#status');
let db;
let conn;
let busy = false;
let marco;
let nfcorpus;

async function run(action) {
  if (busy) return;
  busy = true;
  marco?.setBlocked(true);
  nfcorpus?.setBlocked(true);
  try {
    return await action();
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    console.error(error);
  } finally {
    busy = false;
    marco?.setBlocked(false);
    nfcorpus?.setBlocked(false);
  }
}

const llm = setupLLM();

async function main() {
  if (location.protocol === 'file:') {
    document.querySelector('#local-file-notice').hidden = false;
    throw new Error('Browser storage requires localhost or HTTPS. Follow the instructions above.');
  }
  if (!window.isSecureContext || !navigator.storage?.getDirectory) {
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
  conn = await db.connect();
  nfcorpus = setupNFCorpus(db, conn, run, llm);
  marco = setupMSMarco(run, llm);
  status.textContent = 'Ready.';
  await nfcorpus.reopenSaved();
  await marco.reopenSaved();
}
main().catch(async error => {
  status.textContent = `Startup failed: ${error.message}`;
  console.error(error);
  if (db) await db.terminate().catch(console.error);
});
