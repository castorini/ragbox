import { describe, expect, it, vi } from 'vitest';
import { ResourceStates, collectionReady, createResourceStore, modelReady } from '../src/resource-state.ts';

describe('resource snapshots', () => {
  it('deduplicates copied model status without notifying unrelated resources', () => {
    const states = new ResourceStates();
    const initial = states.state.getState();
    states.set('nfcorpus', 'checking', 'Checking NFCorpus…');
    expect(states.state.getState()).toBe(initial);
    const collections = vi.fn(); const model = vi.fn();
    states.watch(state => [state.resources.nfcorpus, state.resources.msmarco, state.busy], collections, false);
    states.watch(state => state.resources.model, model, false);
    const status = { cache: 'installed' as const, stage: 'ready' as const, downloadedBytes: 42 };
    states.set('model', 'ready', 'Answers ready', status);
    const snapshot = states.state.getState();
    states.set('model', 'ready', 'Answers ready', { ...status });
    expect(states.state.getState()).toBe(snapshot);
    expect(model).toHaveBeenCalledOnce(); expect(collections).not.toHaveBeenCalled();
    status.downloadedBytes = 100;
    expect(states.get('model').model?.downloadedBytes).toBe(42);
  });
  it('keeps factories isolated and shutdown latched when earlier work finishes', () => {
    const states = new ResourceStates(createResourceStore()); const other = new ResourceStates(createResourceStore());
    states.set('nfcorpus', 'ready', 'Ready'); states.set('model', 'ready', 'Ready');
    expect(collectionReady(states.state.getState(), 'nfcorpus')).toBe(true);
    expect(modelReady(states.state.getState())).toBe(true);
    states.setBusy(true, 'nfcorpus'); states.beginShutdown(); states.setBusy(false);
    expect(states.busy).toBe(true); expect(states.activeSearch).toBeUndefined();
    expect(collectionReady(states.state.getState(), 'nfcorpus')).toBe(false);
    expect(modelReady(states.state.getState())).toBe(false);
    expect(other.get('nfcorpus').phase).toBe('checking'); expect(other.busy).toBe(false);
  });
});
