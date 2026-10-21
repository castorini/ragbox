import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { App } from '../src/app/app.tsx';
import { RuntimeProvider } from '../src/app/context.tsx';
import { AppRuntime } from '../src/runtime.ts';
import { ModelService } from '../src/model-service.ts';
import { ConversationStore } from '../src/conversations.ts';
import { memoryRepository } from './conversation-fixtures.ts';
import type { WorkerRequest, WorkerResponse, SearchResult } from '../src/types.ts';
export class UIWorker {
  messages: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  postMessage = vi.fn((message: WorkerRequest) => this.messages.push(message));
  terminate = vi.fn();
  emit(message: WorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>); }
}
export const evidence: SearchResult = { id: 'MED-1', title: 'Nut consumption and cholesterol', text: 'A study found lower LDL cholesterol after eating nuts.', score: 4.125 };
const runtimes = new Set<AppRuntime>();
afterEach(() => { for (const runtime of runtimes) { runtime.chat.dispose(); runtime.model.dispose(); runtime.storage.dispose(); } runtimes.clear(); });
export async function uiHarness({ ready = true, supported = true, historyEnabled = false, url = '/ragbox/' }: { ready?: boolean; supported?: boolean; historyEnabled?: boolean; url?: string } = {}) {
  history.replaceState(null, '', url); localStorage.setItem('ragbox-tour-done', '1');
  const worker = new UIWorker(), workerFactory = vi.fn(() => worker as unknown as Worker);
  const model = new ModelService({ workerFactory, detectWebGPU: async () => supported ? { supported: true } : { supported: false, reason: 'WebGPU unavailable' }, inspectCache: async () => 'missing' });
  const conversations = new ConversationStore(memoryRepository());
  await conversations.initialize();
  const runtime = new AppRuntime({ model, conversations }); runtimes.add(runtime);
  await model.initializeCapability();
  if (ready && supported) { await model.load(); worker.emit({ type: 'ready', model: 'test', revision: 'test' }); }
  const retrieve = vi.fn().mockResolvedValue({ documents: [evidence], elapsedMs: 12 });
  runtime.nfcorpus = { prepare: vi.fn(), retrieve, reopenSaved: vi.fn(), setBlocked: vi.fn(), dispose: vi.fn() };
  runtime.msmarco = { download: vi.fn(), retrieve, openSaved: vi.fn(), cancelDownload: vi.fn(), checkSaved: vi.fn(), reopenSaved: vi.fn(), setBlocked: vi.fn(), close: vi.fn() };
  runtime.resources.set('nfcorpus', 'ready', 'Ready to search.'); runtime.resources.set('msmarco', 'ready', 'Ready to search.');
  runtime.status.setState({ phase: 'ready', message: '' });
  const mounted = render(<StrictMode><RuntimeProvider runtime={runtime}><App historyEnabled={historyEnabled} /></RuntimeProvider></StrictMode>);
  return { runtime, worker, workerFactory, retrieve, ...mounted };
}
