import { afterEach, expect, it, vi } from 'vitest';
import { ResourceStates } from '../src/resource-state.ts';
import { settingsCollectionDetail, setupSettingsView } from '../src/settings-view.ts';
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
  expect(elements.get('#fts-status').textContent).toBe('One-time download saved in this browser.');
  expect(elements.get('#fts-settings-search').hidden).toBe(true);
  expect(elements.get('#marco-status').textContent).toBe('Downloaded. Opens when selected.');
  expect(elements.get('#marco-settings-search')).toMatchObject({ hidden: false, disabled: false });
  elements.get('#marco-settings-search').onclick();
  expect(chooser.search).toHaveBeenCalledExactlyOnceWith('msmarco');
  states.set('msmarco', 'ready', 'Ready to search 8,841,823 passages');
  expect(elements.get('#marco-status')).toMatchObject({ hidden: true, textContent: '' });
});

it('keeps setup progress and failure details scoped to the affected collection', () => {
  const { elements, states } = harness();
  states.set('nfcorpus', 'ready', '');
  states.set('msmarco', 'downloading', 'Downloading: 30%', undefined, 30, false);
  expect(elements.get('#fts-status')).toMatchObject({ hidden: true, textContent: '' });
  expect(elements.get('#marco-settings-search').hidden).toBe(true);
  expect(elements.get('#marco-status')).toMatchObject({ hidden: false, textContent: 'Downloading: 30%' });
  states.set('msmarco', 'error', 'Not enough available browser storage', undefined, undefined, false);
  expect(elements.get('#marco-status').textContent).toContain('Not enough');
  expect(elements.get('#fts-status')).toMatchObject({ hidden: true, textContent: '' });
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
  states.set('model', 'ready', '');
  expect(elements.get('#llm-settings-detail').hidden).toBe(true);
});

it('uses plain-language details for opening, setup, and unavailable collections', () => {
  expect(settingsCollectionDetail({ phase: 'preparing', message: 'Building NFCorpus index…' })).toBe('Building index…');
  expect(settingsCollectionDetail({ phase: 'opening', message: 'Opening MS MARCO index…' })).toBe('Opening index…');
  expect(settingsCollectionDetail({ phase: 'missing', message: '' })).toBe('One-time download saved in this browser.');
  expect(settingsCollectionDetail({ phase: 'unsupported', message: '' })).toBe('Search needs a supported browser on HTTPS or localhost.');
});
