import * as duckdb from '@duckdb/duckdb-wasm';
import { createStore } from 'zustand/vanilla';
import { acquireDatabaseLock } from './database-lock.ts';
import { openLocalDatabase } from './open-local-database.ts';
import { ResourceStates, collectionReady } from './resource-state.ts';
import { LoadCoordinator } from './load-coordinator.ts';
import { createConversationStore, type ConversationStore } from './conversations.ts';
import { ChatController } from './chat-controller.ts';
import { ModelService } from './model-service.ts';
import { createNFCorpusService } from './services/nfcorpus.ts';
import { createMSMarcoService } from './services/msmarco.ts';
import { StorageService } from './services/storage.ts';
import { errorMessage } from './errors.ts';
import type { RunTask } from './types.ts';

export interface DatabaseSession { db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection; terminate(): Promise<void> }
export interface AppStatus { phase: 'opening' | 'ready' | 'error' | 'unsupported' | 'stopped'; message: string }
export interface RuntimeOptions {
  openDatabase?: () => Promise<DatabaseSession>; locks?: LockManager;
  supported?: () => boolean; model?: ModelService; conversations?: ConversationStore;
}
export async function openDatabase(): Promise<DatabaseSession> {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: 'text/javascript' }));
  let worker: Worker | undefined;
  let db: duckdb.AsyncDuckDB | undefined;
  try {
    worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await openLocalDatabase(db, await navigator.storage.getDirectory());
    const conn = await db.connect();
    return { db, conn, terminate: () => db!.terminate() };
  } catch (error) {
    try { await db?.terminate(); } finally { worker?.terminate(); }
    throw error;
  } finally { URL.revokeObjectURL(workerUrl); }
}

// Document lifetime, independent of React mounting and development Strict Mode.
export class AppRuntime {
  readonly resources = new ResourceStates();
  readonly loads = new LoadCoordinator();
  readonly status = createStore<AppStatus>(() => ({ phase: 'opening', message: 'Opening database…' }));
  readonly conversations: ConversationStore;
  readonly model: ModelService;
  readonly chat: ChatController;
  readonly storage: StorageService;
  nfcorpus?: ReturnType<typeof createNFCorpusService>;
  msmarco?: ReturnType<typeof createMSMarcoService>;
  private session?: DatabaseSession;
  private releaseLock?: () => void;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private unsubscribeSelection?: () => void;
  private unsubscribeModel: () => void;
  private onPageHide = () => { void this.conversations.flush(); };
  readonly run: RunTask = async (task, corpus) => {
    if (this.resources.busy || this.resources.shuttingDown) return;
    this.resources.setBusy(true, corpus);
    try { return await task(); }
    catch (error) { this.status.setState({ phase: 'error', message: `Error: ${errorMessage(error)}` }); console.error(error); }
    finally { this.resources.setBusy(false); }
  };
  constructor(private options: RuntimeOptions = {}) {
    this.conversations = options.conversations ?? createConversationStore();
    this.model = options.model ?? new ModelService({ loads: this.loads });
    this.unsubscribeModel = this.model.subscribe(() => this.resources.set('model', this.model.state, this.model.statusText(), { ...this.model.model }));
    this.chat = new ChatController(this.conversations, this.model, {
      ready: corpus => collectionReady(this.resources.state.getState(), corpus), busy: () => this.resources.busy,
      subscribe: listener => this.resources.watch(s => [s.busy, s.shuttingDown, s.resources.nfcorpus.phase, s.resources.msmarco.phase], listener, false),
      retrieve: (corpus, query) => {
        const service = corpus === 'nfcorpus' ? this.nfcorpus : this.msmarco;
        if (!service) return Promise.reject(new Error('The collection is still opening.'));
        return service.retrieve(query);
      },
    });
    this.storage = new StorageService(this.resources, () => this.shutdown(), () => { void this.model.refreshCache(); });
    this.model.setOnLoadSettled(() => { void this.storage.refresh(); });
  }
  start() { return this.stopping ?? (this.starting ??= this.initialize()); }
  private async initialize() {
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    const conversationsReady = this.conversations.initialize();
    const capability = this.model.initializeCapability();
    try {
      const supported = this.options.supported?.() ?? Boolean(globalThis.isSecureContext && navigator.storage?.getDirectory);
      if (!supported) {
        for (const corpus of ['nfcorpus', 'msmarco'] as const) this.resources.set(corpus, 'unsupported', 'OPFS is unavailable in this browser.');
        throw new Error('OPFS requires a supported browser on localhost or HTTPS');
      }
      this.releaseLock = await acquireDatabaseLock(this.options.locks ?? globalThis.navigator?.locks);
      if (this.resources.shuttingDown) return;
      this.session = await (this.options.openDatabase ?? openDatabase)();
      if (this.resources.shuttingDown) return;
      const { db, conn } = this.session;
      this.nfcorpus = createNFCorpusService(db, conn, this.run, (phase, message) => this.resources.set('nfcorpus', phase, message), this.loads, this.resources);
      this.msmarco = createMSMarcoService(this.run, (phase, message, progress, savedAvailable) => this.resources.set('msmarco', phase, message, undefined, progress, savedAvailable), this.loads, this.resources);
      this.unsubscribeSelection = this.conversations.watch(s => s.selected, value => { if (value === 'msmarco') void this.msmarco?.reopenSaved(); });
      await this.loads.run(() => this.nfcorpus!.reopenSaved());
      await this.msmarco.checkSaved();
      await conversationsReady;
      if (this.resources.shuttingDown) return;
      if (this.status.getState().phase !== 'error') this.status.setState({ phase: 'ready', message: '' });
      if (this.conversations.selected === 'msmarco') void this.msmarco.reopenSaved();
      if ((await capability).supported && this.model.model.cache === 'installed' && !this.resources.shuttingDown) void this.model.loadAndWait(true).catch(console.error);
    } catch (error) {
      const message = `Startup failed: ${errorMessage(error)}`;
      const unsupported = this.resources.get('nfcorpus').phase === 'unsupported';
      this.status.setState({ phase: unsupported ? 'unsupported' : 'error', message });
      for (const corpus of ['nfcorpus', 'msmarco'] as const) if (!unsupported) this.resources.set(corpus, 'error', message);
      console.error(error);
      await this.terminateDatabase().catch(console.error);
    } finally { await this.storage.initialize(); }
  }
  private async terminateDatabase() {
    await this.session?.terminate();
    this.session = undefined;
    this.releaseLock?.(); this.releaseLock = undefined;
  }
  shutdown() {
    if (this.stopping) return this.stopping;
    this.resources.beginShutdown();
    this.chat.dispose(); this.model.dispose();
    this.stopping = (async () => {
      await this.starting;
      this.unsubscribeSelection?.(); this.unsubscribeModel(); this.storage.dispose(); this.nfcorpus?.dispose();
      globalThis.removeEventListener?.('pagehide', this.onPageHide);
      await this.conversations.flush();
      await this.loads.run(async () => {
        await this.msmarco?.close();
        if (this.session) { await this.session.conn.query('CHECKPOINT'); await this.session.conn.close(); }
        await this.terminateDatabase();
      });
      this.status.setState({ phase: 'stopped', message: 'Reload this page to continue.' });
    })();
    return this.stopping;
  }
}
