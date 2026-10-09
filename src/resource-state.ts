import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/vanilla/shallow';
import type { Corpus, ModelStatus } from './types.ts';

export type ResourceName = 'nfcorpus' | 'msmarco' | 'model';
export type ResourcePhase =
  | 'checking' | 'missing' | 'saved' | 'opening' | 'preparing'
  | 'downloading' | 'ready' | 'idle' | 'loading' | 'generating' | 'error' | 'unsupported';

export interface ResourceState {
  phase: ResourcePhase;
  message: string;
  model?: ModelStatus;
  progress?: number;
  savedAvailable?: boolean;
}
export interface ResourceSnapshot {
  resources: Record<ResourceName, ResourceState>;
  busy: boolean;
  activeSearch?: Corpus;
  shuttingDown: boolean;
}
export function createResourceStore() {
  return createStore(subscribeWithSelector<ResourceSnapshot>(() => ({
    resources: {
      nfcorpus: { phase: 'checking', message: 'Checking NFCorpus…' },
      msmarco: { phase: 'checking', message: 'Checking for a saved MS MARCO index…' },
      model: { phase: 'checking', message: 'Checking WebGPU support…' },
    },
    busy: false,
    shuttingDown: false,
  })));
}
export function collectionReady(state: ResourceSnapshot, corpus: Corpus) {
  return !state.shuttingDown && state.resources[corpus].phase === 'ready';
}
export function modelReady(state: ResourceSnapshot) {
  return !state.shuttingDown && ['ready', 'generating'].includes(state.resources.model.phase);
}

// Domain methods share one Zustand snapshot; runtime handles stay in their services.
export class ResourceStates {
  constructor(readonly state = createResourceStore()) {}
  get busy() { return this.state.getState().busy; }
  get activeSearch() { return this.state.getState().activeSearch; }
  get shuttingDown() { return this.state.getState().shuttingDown; }
  get(name: ResourceName): ResourceState { return this.state.getState().resources[name]; }
  set(name: ResourceName, phase: ResourcePhase, message: string, model?: ModelStatus, progress?: number, savedAvailable?: boolean) {
    this.state.setState(snapshot => {
      const previous = snapshot.resources[name];
      if (previous.phase === phase && previous.message === message && previous.progress === progress && previous.savedAvailable === savedAvailable && shallow(previous.model, model)) return snapshot;
      const status = shallow(previous.model, model) ? previous.model : model && { ...model };
      const next = { phase, message, model: status, progress, savedAvailable };
      return { resources: { ...snapshot.resources, [name]: next } };
    });
  }
  setBusy(busy: boolean, searchCorpus?: Corpus) {
    this.state.setState(snapshot => {
      if (snapshot.shuttingDown) return snapshot;
      const activeSearch = busy ? searchCorpus : undefined;
      return snapshot.busy === busy && snapshot.activeSearch === activeSearch ? snapshot : { busy, activeSearch };
    });
  }
  beginShutdown() { this.state.setState({ busy: true, activeSearch: undefined, shuttingDown: true }); }
  watch<T>(selector: (state: ResourceSnapshot) => T, listener: (value: T, previous: T) => void, fireImmediately = true) {
    return this.state.subscribe(selector, listener, { equalityFn: shallow, fireImmediately });
  }
  subscribe(listener: () => void) { return this.watch(state => state, listener); }
}
