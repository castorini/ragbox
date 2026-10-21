// @vitest-environment jsdom
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppRuntime, type DatabaseSession } from '../src/runtime.ts';
import { ModelService } from '../src/model-service.ts';
import { ConversationStore } from '../src/conversations.ts';
import { memoryRepository } from './conversation-fixtures.ts';
import { RuntimeProvider } from '../src/app/context.tsx';
import { App } from '../src/app/app.tsx';
it('retains one document runtime through Strict Mode and complete UI remounts', async () => {
  localStorage.setItem('ragbox-tour-done', '1'); history.replaceState(null, '', '/ragbox/');
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: vi.fn(async () => ({ getFileHandle: async () => { throw new DOMException('Missing', 'NotFoundError'); }, async *entries() {} })) } });
  const query = vi.fn(async () => ({ toArray: () => [{ n: 0 }] })), terminate = vi.fn(async () => {}), close = vi.fn(async () => {});
  const openDatabase = vi.fn(async () => ({ db: {}, conn: { query, close }, terminate }) as unknown as DatabaseSession);
  const workerFactory = vi.fn();
  const model = new ModelService({ detectWebGPU: async () => ({ supported: false, reason: 'No GPU' }), inspectCache: async () => 'missing', workerFactory });
  const runtime = new AppRuntime({ openDatabase, model, conversations: new ConversationStore(memoryRepository()) });
  const starting = runtime.start();
  const ui = () => <StrictMode><RuntimeProvider runtime={runtime}><App /></RuntimeProvider></StrictMode>;
  const first = render(ui());
  await waitFor(() => expect(first.container.querySelector('main')).toHaveAttribute('data-startup', 'ready'));
  first.unmount(); expect(terminate).not.toHaveBeenCalled();
  const second = render(ui()); expect(runtime.start()).toBe(starting);
  expect(openDatabase).toHaveBeenCalledOnce(); expect(workerFactory).not.toHaveBeenCalled();
  second.unmount(); expect(terminate).not.toHaveBeenCalled(); await runtime.shutdown(); expect(terminate).toHaveBeenCalledOnce();
});
