import { openLocalDatabase } from './open-local-database.ts';
import { setupSearchGuidance } from './search-guidance.ts';
import { setupCollectionChooser } from './collection-chooser.ts';
import * as duckdb from '@duckdb/duckdb-wasm';
import { setupNFCorpus } from './nfcorpus.ts';
import { setupMSMarco } from './msmarco.ts';
import { setupLLM } from './llm-controller.ts';
import { errorMessage, requiredElement } from './boundaries.ts';
import type { RunTask } from './types.ts';
import { ResourceStates, collectionReady } from './resource-state.ts';
import { LoadCoordinator } from './load-coordinator.ts';
import { setupStorageDashboard } from './storage-dashboard.ts';
import { setupCorpusDashboard } from './corpus-dashboard.ts';
import { setupSettingsView } from './settings-view.ts';
import { createConversationStore } from './conversations.ts';
import { ChatController } from './chat-controller.ts';
import { setupChatView, setupConversationHistory } from './chat-view.ts';
import { HISTORY_ENABLED } from './features.ts';
import { setupTour, tourSeen } from './tour.ts';

const status = requiredElement<HTMLElement>('#status');
const states = new ResourceStates();
const loads = new LoadCoordinator();
const conversations = createConversationStore();
const conversationsReady = conversations.initialize();
const tour = setupTour({ modelPhase: () => states.get('model').phase });
requiredElement<HTMLButtonElement>('#tour-start').onclick = () => tour.start();
// First visit: walk through the search page once the layout has settled.
if (!tourSeen()) {
  setTimeout(() => {
    const onSearch = !requiredElement<HTMLElement>('#search-view').hidden;
    const hasResults = conversations.current().turns.length > 0;
    if (onSearch && !hasResults) tour.start();
  }, 700);
}
let db: duckdb.AsyncDuckDB | undefined;
let marco: ReturnType<typeof setupMSMarco> | undefined;
let nfcorpus: ReturnType<typeof setupNFCorpus> | undefined;
const chooser = setupCollectionChooser(value => {
  chat.select(value);
}, () => chat.newChat(), true, HISTORY_ENABLED, conversations);
const unsubscribeSelection = conversations.watch(state => state.selected, value => {
  if (value === 'msmarco') void marco?.reopenSaved();
});
const setupActions = {
  prepare: () => nfcorpus?.prepare(),
  download: () => marco?.download(),
  openSaved: () => marco?.openSaved(),
  cancelDownload: () => marco?.cancelDownload(),
};
const guidance = setupSearchGuidance(states, setupActions);
const dashboard = setupCorpusDashboard(states, chooser, setupActions);
const settings = setupSettingsView(states, chooser);

const run: RunTask = async (action, searchCorpus) => {
  if (states.busy) return;
  states.setBusy(true, searchCorpus);
  try {
    return await action();
  } catch (error) {
    status.textContent = `Error: ${errorMessage(error)}`;
    console.error(error);
  } finally {
    states.setBusy(false);
  }
};

const llm = setupLLM((phase, message, model) => states.set('model', phase, message, model), loads);
const chat = new ChatController(conversations, llm, {
  ready: corpus => collectionReady(states.state.getState(), corpus),
  busy: () => states.busy,
  subscribe: listener => states.watch(state => [state.busy, state.shuttingDown, state.resources.nfcorpus.phase, state.resources.msmarco.phase], listener, false),
  retrieve: async (corpus, query) => {
    const collection = corpus === 'nfcorpus' ? nfcorpus : marco;
    if (!collection) throw new Error('The collection is still opening.');
    return collection.retrieve(query);
  },
});
const chatView = setupChatView(chat, states);
let historyView: ReturnType<typeof setupConversationHistory> | undefined;
if (HISTORY_ENABLED) {
  historyView = setupConversationHistory(chat, conversation => {
    chat.open(conversation.id);
    chooser.showSearch();
  });
}
window.addEventListener('pagehide', () => { void conversations.flush(); });
const capability = llm.initializeCapability();
let conn: duckdb.AsyncDuckDBConnection | undefined;
const storage = setupStorageDashboard(states, async () => {
  states.beginShutdown();
  requiredElement<HTMLButtonElement>('#llm-load').disabled = true;
  chat.dispose();
  chatView.dispose(); historyView?.dispose();
  chooser.dispose(); dashboard.dispose(); guidance.dispose(); settings.dispose();
  unsubscribeSelection(); nfcorpus?.dispose();
  await conversations.flush();
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
    (phase, message) => states.set('nfcorpus', phase, message), loads, undefined, states);
  marco = setupMSMarco(run, llm,
    (phase, message, progress, savedAvailable) => states.set('msmarco', phase, message, undefined, progress, savedAvailable), loads, undefined, states);
  status.textContent = 'Ready.';
  await loads.run(() => nfcorpus!.reopenSaved());
  await marco.checkSaved();
  await conversationsReady;
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
