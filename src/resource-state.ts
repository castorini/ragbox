import type { Corpus } from './types.ts';

export type ResourceName = 'nfcorpus' | 'msmarco' | 'model';
export type ResourcePhase =
  | 'checking' | 'missing' | 'saved' | 'opening' | 'preparing'
  | 'downloading' | 'ready' | 'idle' | 'loading' | 'generating' | 'error' | 'unsupported';

export interface ResourceState {
  phase: ResourcePhase;
  message: string;
}

export class ResourceStates {
  private values: Record<ResourceName, ResourceState> = {
    nfcorpus: { phase: 'checking', message: 'Checking NFCorpus…' },
    msmarco: { phase: 'checking', message: 'Checking for a saved MS MARCO index…' },
    model: { phase: 'checking', message: 'Checking WebGPU support…' },
  };
  private listeners = new Set<() => void>();
  busy = false;
  activeSearch: Corpus | undefined;

  get(name: ResourceName): ResourceState { return this.values[name]; }

  set(name: ResourceName, phase: ResourcePhase, message: string) {
    this.values[name] = { phase, message };
    this.notify();
  }

  setBusy(busy: boolean, searchCorpus?: Corpus) {
    this.busy = busy;
    this.activeSearch = busy ? searchCorpus : undefined;
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  private notify() { for (const listener of this.listeners) listener(); }
}
