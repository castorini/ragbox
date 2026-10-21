import { afterEach, expect, it, vi } from 'vitest';
import { AppRuntime, type DatabaseSession } from '../src/runtime.ts';
import { ModelService } from '../src/model-service.ts';
import { ConversationStore } from '../src/conversations.ts';
import { memoryRepository } from './conversation-fixtures.ts';

function harness() {
  const root = { getFileHandle: vi.fn().mockRejectedValue(new DOMException('Missing', 'NotFoundError')), async *entries() {} };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(root) } });
  const query = vi.fn().mockResolvedValue({ toArray: () => [{ n: 0 }] });
  const terminate = vi.fn().mockResolvedValue(undefined);
  const session = { db: {}, conn: { query, close: vi.fn().mockResolvedValue(undefined) }, terminate } as unknown as DatabaseSession;
  const openDatabase = vi.fn().mockResolvedValue(session);
  const model = new ModelService({ detectWebGPU: async () => ({ supported: false, reason: 'No GPU' }), inspectCache: async () => 'missing' });
  const conversations = new ConversationStore(memoryRepository());
  const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<void>) => Promise.resolve().then(() => callback({ name: 'test', mode: 'exclusive' })));
  const runtime = new AppRuntime({ openDatabase, model, conversations, supported: () => true, locks: { request } as unknown as LockManager });
  return { runtime, openDatabase, terminate, request, session, model };
}
afterEach(() => vi.unstubAllGlobals());
it('starts once even when multiple React mounts request startup; shuts down once after the database closes', async () => {
  const h = harness();
  const starting = h.runtime.start();
  expect(h.runtime.start()).toBe(starting);
  await starting;
  expect(h.openDatabase).toHaveBeenCalledOnce(); expect(h.request).toHaveBeenCalledOnce();
  expect(h.runtime.status.getState().phase).toBe('ready');
  expect(h.runtime.resources.get('nfcorpus').phase).toBe('missing');
  expect(h.runtime.resources.get('model').phase).toBe('unsupported');
  const stopping = h.runtime.shutdown(); expect(h.runtime.shutdown()).toBe(stopping);
  await stopping;
  expect(h.terminate).toHaveBeenCalledOnce();
  expect(h.session.conn.close).toHaveBeenCalledOnce();
  await expect(h.request.mock.results[0].value).resolves.toBeUndefined();
});
it('releases the acquired lock when startup fails and preserves the actual failure', async () => {
  const h = harness(); vi.spyOn(console, 'error').mockImplementation(() => {});
  h.openDatabase.mockRejectedValue(new Error('Initialization failed'));
  await h.runtime.start();
  expect(h.runtime.status.getState().message).toContain('Initialization failed');
  await expect(h.request.mock.results[0].value).resolves.toBeUndefined();
  await h.runtime.shutdown();
});
it('rejects a duplicate before constructing a database worker', async () => {
  const h = harness(); vi.spyOn(console, 'error').mockImplementation(() => {});
  h.request.mockImplementation((_name: string, _options: LockOptions, callback: LockGrantedCallback<void>) => Promise.resolve().then(() => callback(null)));
  await h.runtime.start();
  expect(h.openDatabase).not.toHaveBeenCalled();
  expect(h.runtime.status.getState().message).toContain('another tab or window');
  await h.runtime.shutdown();
});
it('holds ownership until an in-flight startup has terminated during shutdown', async () => {
  const h = harness();
  let finish!: (session: DatabaseSession) => void;
  h.openDatabase.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const starting = h.runtime.start();
  await vi.waitFor(() => expect(h.openDatabase).toHaveBeenCalledOnce());
  const stopping = h.runtime.shutdown();
  expect(h.terminate).not.toHaveBeenCalled();
  finish(h.session);
  await Promise.all([starting, stopping]);
  expect(h.terminate).toHaveBeenCalledOnce();
  expect(h.runtime.status.getState().phase).toBe('stopped');
});
it('does not release ownership when terminating the database fails', async () => {
  const h = harness(); await h.runtime.start();
  h.terminate.mockRejectedValue(new Error('Still running'));
  await expect(h.runtime.shutdown()).rejects.toThrow('Still running');
  const released = vi.fn(); void h.request.mock.results[0].value.then(released);
  await Promise.resolve(); expect(released).not.toHaveBeenCalled();
});
