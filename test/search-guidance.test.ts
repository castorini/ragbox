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
  expect(get('#fts-query').disabled).toBe(false);
  expect(get('#fts-search').disabled).toBe(true);
  expect(get('#fts-help-text').textContent).toContain('Checking');

  states.set('nfcorpus', 'missing', 'No saved index');
  expect(get('#fts-help-text').textContent).toContain('needs an index');
  states.set('nfcorpus', 'ready', 'Ready');
  expect(get('#fts-query').disabled).toBe(false);
  expect(get('#fts-help').hidden).toBe(true);

  states.setBusy(true);
  expect(get('#fts-query').disabled).toBe(false);
  expect(get('#fts-search').disabled).toBe(true);
  expect(get('#fts-help-text').textContent).toContain('temporarily paused');
  states.setBusy(false);
  expect(get('#fts-query').disabled).toBe(false);

  states.set('msmarco', 'saved', 'Saved');
  expect(get('#marco-query').disabled).toBe(false);
  expect(get('#marco-search').disabled).toBe(true);
  expect(get('#marco-help-text').textContent).toContain('when you select');
  states.set('msmarco', 'ready', 'Ready');
  expect(get('#marco-query').disabled).toBe(false);
  states.setBusy(true, 'msmarco');
  expect(get('#marco-query').disabled).toBe(false);
  expect(get('#marco-search').disabled).toBe(true);
  expect(get('#marco-help').hidden).toBe(true);
  expect(get('#fts-help').hidden).toBe(false);
  expect(get('#fts-help-text').textContent).toContain('temporarily paused');
  states.setBusy(false);
  expect(get('#marco-query').disabled).toBe(false);
  expect(get('#marco-help').hidden).toBe(true);
  states.set('nfcorpus', 'error', 'Startup failed: database unavailable');
  expect(get('#fts-help-text').textContent).toContain('Reload');
});

it('runs shared setup actions, keeps queries, and displays the same download progress', () => {
  type Node = { disabled: boolean; hidden: boolean; textContent: string; value: string | number;
    onclick?: () => void; setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>;
    classList: { toggle: ReturnType<typeof vi.fn> } };
  const nodes = new Map<string, Node>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { disabled: false, hidden: false, textContent: '', value: '',
      setAttribute: vi.fn(), removeAttribute: vi.fn(), classList: { toggle: vi.fn() } });
    return nodes.get(id)!;
  };
  vi.stubGlobal('document', { querySelector: get });
  const states = new ResourceStates();
  const actions = { prepare: vi.fn(), download: vi.fn(), openSaved: vi.fn(), cancelDownload: vi.fn() };
  setupSearchGuidance(states, actions);
  get('#fts-query').value = 'nutrition';
  get('#marco-query').value = 'broccoli';
  states.set('nfcorpus', 'missing', 'Not prepared');
  states.set('msmarco', 'missing', 'Not downloaded');
  get('#fts-prepare').onclick?.();
  get('#marco-download').onclick?.();
  expect(actions.prepare).toHaveBeenCalledOnce();
  expect(actions.download).toHaveBeenCalledOnce();
  states.set('nfcorpus', 'preparing', 'Building index…');
  expect(get('#fts-help-text').textContent).toBe('Building index…');
  expect(get('#fts-query').disabled).toBe(false);
  states.set('msmarco', 'downloading', 'Downloaded 1 GB (30%)', undefined, 30);
  expect(get('#marco-help-text').textContent).toBe('Downloaded 1 GB (30%)');
  expect(get('#marco-search-progress')).toMatchObject({ hidden: false, value: 30 });
  expect(get('#marco-search-cancel').hidden).toBe(false);
  get('#marco-search-cancel').onclick?.();
  expect(actions.cancelDownload).toHaveBeenCalledOnce();
  states.set('msmarco', 'saved', 'Saved index available');
  expect(get('#marco-open').hidden).toBe(false);
  get('#marco-open').onclick?.();
  expect(actions.openSaved).toHaveBeenCalledOnce();
  states.set('nfcorpus', 'ready', 'Ready');
  states.set('msmarco', 'ready', 'Ready');
  expect(get('#fts-query').value).toBe('nutrition');
  expect(get('#marco-query').value).toBe('broccoli');
  expect(get('#fts-search').disabled).toBe(false);
  expect(get('#marco-search').disabled).toBe(false);
});
