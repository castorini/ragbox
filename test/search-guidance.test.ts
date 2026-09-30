import { it, expect, vi, afterEach } from 'vitest';
import { setupSearchGuidance } from '../src/search-guidance.ts';
import { ResourceStates } from '../src/resource-state.ts';

afterEach(() => vi.unstubAllGlobals());

it('uses explicit readiness to mute search and keeps the model optional', () => {
  type FakeNode = {
    disabled: boolean; hidden: boolean; textContent: string;
    setAttribute: ReturnType<typeof vi.fn>;
    classList: { toggle: ReturnType<typeof vi.fn> };
  };
  const nodes = new Map<string, FakeNode>();
  vi.stubGlobal('document', { querySelector(id: string) {
    if (!nodes.has(id)) nodes.set(id, {
      disabled: false, hidden: false, textContent: '', setAttribute: vi.fn(),
      classList: { toggle: vi.fn() },
    });
    return nodes.get(id);
  } });
  const get = (id: string) => nodes.get(id)!;
  const states = new ResourceStates();
  setupSearchGuidance(states);
  expect(get('#fts-query').disabled).toBe(true);
  expect(get('#fts-help-text').textContent).toContain('Checking');

  states.set('nfcorpus', 'missing', 'No saved index');
  expect(get('#fts-help-text').textContent).toContain('needs an index');
  states.set('nfcorpus', 'ready', 'Ready');
  expect(get('#fts-query').disabled).toBe(false);
  expect(get('#fts-help').hidden).toBe(true);
  expect(get('#model-search-status').textContent).toContain('optional');

  states.setBusy(true);
  expect(get('#fts-query').disabled).toBe(true);
  expect(get('#fts-help-text').textContent).toContain('temporarily paused');
  states.setBusy(false);
  expect(get('#fts-query').disabled).toBe(false);
  states.set('model', 'ready', 'Model ready');
  expect(get('#model-search-status').textContent).toBe('Cited answers ready');

  states.set('msmarco', 'saved', 'Saved');
  expect(get('#marco-query').disabled).toBe(true);
  expect(get('#marco-help-text').textContent).toContain('when you select');
  states.set('msmarco', 'ready', 'Ready');
  expect(get('#marco-query').disabled).toBe(false);
  states.setBusy(true, 'msmarco');
  expect(get('#marco-query').disabled).toBe(true);
  expect(get('#marco-help').hidden).toBe(true);
  expect(get('#fts-help').hidden).toBe(false);
  expect(get('#fts-help-text').textContent).toContain('temporarily paused');
  states.setBusy(false);
  expect(get('#marco-query').disabled).toBe(false);
  expect(get('#marco-help').hidden).toBe(true);
  states.set('nfcorpus', 'error', 'Startup failed: database unavailable');
  expect(get('#fts-help-text').textContent).toContain('Reload');
});
