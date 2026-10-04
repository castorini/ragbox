import { afterEach, expect, it, vi } from 'vitest';
import { ResourceStates } from '../src/resource-state.ts';
import { settingsCollectionStatus, setupSettingsView } from '../src/settings-view.ts';
import { FakeElements } from './fake-elements.ts';

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const elements = new FakeElements();
  vi.stubGlobal('document', { querySelector: (id: string) => {
    const element = elements.get(id);
    if (!('setAttribute' in element)) Object.assign(element, { setAttribute: vi.fn() });
    return element;
  } });
  const states = new ResourceStates();
  const chooser = { search: vi.fn() };
  setupSettingsView(states, chooser);
  return { elements, states, chooser };
}

it('distinguishes a downloaded collection from an open collection and searches without downloading', () => {
  const { elements, states, chooser } = harness();
  states.set('nfcorpus', 'missing', '');
  states.set('msmarco', 'saved', 'Saved index available', undefined, undefined, true);
  expect(elements.get('#fts-settings-state').textContent).toBe('Not set up');
  expect(elements.get('#fts-settings-search').hidden).toBe(true);
  expect(elements.get('#marco-settings-state').textContent).toBe('Downloaded');
  expect(elements.get('#marco-status').textContent).toBe('Opens when selected.');
  expect(elements.get('#marco-settings-search')).toMatchObject({ hidden: false, disabled: false });
  elements.get('#marco-settings-search').onclick();
  expect(chooser.search).toHaveBeenCalledExactlyOnceWith('msmarco');
  states.set('msmarco', 'ready', 'Ready to search 8,841,823 passages');
  expect(elements.get('#marco-settings-state').textContent).toBe('Ready to search');
  expect(elements.get('#marco-status').hidden).toBe(true);
});

it('keeps setup progress and failure details scoped to the affected collection', () => {
  const { elements, states } = harness();
  states.set('nfcorpus', 'ready', '');
  states.set('msmarco', 'downloading', 'Downloading: 30%', undefined, 30, false);
  expect(elements.get('#fts-settings-state').textContent).toBe('Ready to search');
  expect(elements.get('#fts-status').hidden).toBe(true);
  expect(elements.get('#marco-settings-search').hidden).toBe(true);
  expect(elements.get('#marco-status')).toMatchObject({ hidden: false, textContent: 'Downloading: 30%' });
  states.set('msmarco', 'error', 'Not enough available browser storage', undefined, undefined, false);
  expect(elements.get('#marco-status').textContent).toContain('Not enough');
  expect(elements.get('#fts-settings-state').textContent).toBe('Ready to search');
  states.setBusy(true);
  elements.get('#fts-settings-search').onclick();
  expect(elements.get('#fts-settings-search').disabled).toBe(true);
});

it('explains that unsupported AI answers do not prevent document search', () => {
  const { elements, states } = harness();
  states.set('nfcorpus', 'ready', '');
  states.set('model', 'unsupported', 'WebGPU unavailable');
  expect(elements.get('#llm-settings-detail')).toMatchObject({ hidden: false });
  expect(elements.get('#llm-settings-detail').textContent).toContain('Document search remains available');
  expect(elements.get('#fts-settings-search').disabled).toBe(false);
  states.set('model', 'ready', 'Answers ready');
  expect(elements.get('#llm-settings-detail').hidden).toBe(true);
});

it('uses plain-language labels for opening, setup, and unavailable collections', () => {
  expect(settingsCollectionStatus('nfcorpus', { phase: 'preparing', message: 'Building index…' }))
    .toEqual({ label: 'Setting up…', detail: 'Building index…' });
  expect(settingsCollectionStatus('msmarco', { phase: 'opening', message: 'Opening index…' }).label).toBe('Opening…');
  expect(settingsCollectionStatus('msmarco', { phase: 'missing', message: '' }).label).toBe('Not downloaded');
  expect(settingsCollectionStatus('nfcorpus', { phase: 'unsupported', message: '' }).label).toBe('Unavailable');
});
