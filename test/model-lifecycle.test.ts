import { expect, it, vi } from 'vitest';
import { ModelService } from '../src/model-service.ts';
import { LoadCoordinator } from '../src/load-coordinator.ts';
import type { ModelCacheAvailability, WorkerRequest, WorkerResponse } from '../src/types.ts';
class WorkerStub {
  messages: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  terminate = vi.fn();
  postMessage(message: WorkerRequest) { this.messages.push(message); }
  emit(message: WorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>); }
}
function lifecycle(cache: ModelCacheAvailability = 'missing', loads = new LoadCoordinator()) {
  const workers: WorkerStub[] = [];
  const workerFactory = vi.fn(() => { const w = new WorkerStub(); workers.push(w); return w as unknown as Worker; });
  const model = new ModelService({ workerFactory, detectWebGPU: async () => ({ supported: true }), inspectCache: async () => cache, loads });
  return { model, workerFactory, workers, loads };
}
it.each([
  ['missing', 'Download model (~1.84 GB)'], ['incomplete', 'Download missing files'], ['corrupt', 'Download missing files'], ['installed', 'Load saved model'], ['unknown', 'Load saved model'],
] as const)('offers the correct explicit load action for %s files without constructing a worker', async (cache, label) => {
  const h = lifecycle(cache); await h.model.initializeCapability(); expect(h.model.loadAction()).toBe(label); expect(h.workerFactory).not.toHaveBeenCalled(); h.model.dispose();
});
it('shares a single capability check and loads the model only when requested', async () => {
  const detect = vi.fn(async () => ({ supported: true as const }));
  const model = new ModelService({ detectWebGPU: detect, inspectCache: async () => 'missing' });
  const one = model.initializeCapability(); const two = model.initializeCapability(); expect(one).toBe(two); await one; expect(detect).toHaveBeenCalledOnce(); model.dispose();
});
it('holds coordinated loading until a terminal worker event', async () => {
  const h = lifecycle(); await h.model.initializeCapability(); const loading = h.model.loadAndWait(true);
  await vi.waitFor(() => expect(h.workerFactory).toHaveBeenCalledOnce());
  const next = vi.fn(); const pending = h.loads.run(async () => next()); await Promise.resolve(); expect(next).not.toHaveBeenCalled();
  h.workers[0].emit({ type: 'ready', model: 'test', revision: 'test' }); await Promise.all([pending, loading]); expect(next).toHaveBeenCalledOnce(); h.model.dispose();
});
it('cancels a queued load before constructing its worker and releases the queue', async () => {
  const h = lifecycle(); await h.model.initializeCapability(); let release!: () => void;
  const blocking = h.loads.run(() => new Promise<void>(resolve => { release = resolve; })); await Promise.resolve();
  const loading = h.model.loadAndWait(true); h.model.cancelLoad(); release(); await Promise.all([blocking, loading]); expect(h.workerFactory).not.toHaveBeenCalled(); h.model.dispose();
});
it('cancels active loading and retries with a fresh worker while ignoring old events', async () => {
  const h = lifecycle(); await h.model.initializeCapability(); await h.model.load(); const old = h.workers[0];
  h.model.cancelLoad(); expect(old.terminate).toHaveBeenCalledOnce(); old.emit({ type: 'ready', model: 'old', revision: 'old' }); expect(h.model.ready).toBe(false);
  await h.model.load(); h.workers[1].emit({ type: 'ready', model: 'new', revision: 'new' }); expect(h.model.ready).toBe(true); h.model.dispose();
});
it('reports cache unavailability without automatically downloading replacement weights', async () => {
  const h = lifecycle('installed'); await h.model.initializeCapability(); await h.model.load(true);
  h.workers[0].emit({ type: 'cache-unavailable', operation: 'load', reason: 'missing', message: 'Files missing' });
  expect(h.model.ready).toBe(false); expect(h.workerFactory).toHaveBeenCalledOnce(); expect(h.model.loadAction()).toBe('Download model (~1.84 GB)'); h.model.dispose();
});
it('shows bytes without inventing a whole-model percentage and distinguishes initialization', async () => {
  const h = lifecycle(); await h.model.initializeCapability(); await h.model.load();
  h.workers[0].emit({ type: 'progress', progress: { stage: 'downloading', downloadedBytes: 2048 } }); expect(h.model.statusText()).toContain('2.0 KB');
  h.workers[0].emit({ type: 'progress', progress: { stage: 'initializing' } }); expect(h.model.statusText()).toContain('Initializing'); h.model.dispose();
});
it('releases the load coordinator after worker construction fails', async () => {
  const h = lifecycle(); await h.model.initializeCapability(); h.workerFactory.mockImplementationOnce(() => { throw new Error('Cannot create worker'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {}); await h.model.loadAndWait(true); expect(h.model.state).toBe('error'); const next = vi.fn(); await h.loads.run(async () => next()); expect(next).toHaveBeenCalledOnce(); h.model.dispose();
});
