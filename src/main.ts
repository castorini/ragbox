import { setupSearchGuidance } from './search-guidance.ts';
import { setupCollectionChooser } from './collection-chooser.ts';
import * as duckdb from '@duckdb/duckdb-wasm';
import './style.css';
import { setupNFCorpus } from './nfcorpus.ts';
import { setupMSMarco } from './msmarco.ts';
import { setupLLM } from './llm-controller.ts';
import { errorMessage, requiredElement } from './boundaries.ts';
import type { RunTask } from './types.ts';

setupCollectionChooser();
setupSearchGuidance();

const status = requiredElement<HTMLElement>('#status');
let db: duckdb.AsyncDuckDB | undefined;
let busy = false;
let marco: ReturnType<typeof setupMSMarco> | undefined;
let nfcorpus: ReturnType<typeof setupNFCorpus> | undefined;

const run: RunTask = async action => {
  if (busy) return;
  busy = true;
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
  }
};

const llm = setupLLM();

async function main() {
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
  const conn = await db.connect();
  nfcorpus = setupNFCorpus(db, conn, run, llm);
  marco = setupMSMarco(run, llm);
  status.textContent = 'Ready.';
  await nfcorpus.reopenSaved();
  await marco.reopenSaved();
}
main().catch(async error => {
  status.textContent = `Startup failed: ${errorMessage(error)}`;
  console.error(error);
  if (db) await db.terminate().catch(console.error);
});
