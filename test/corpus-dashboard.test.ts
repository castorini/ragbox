import { afterEach, expect, it, vi } from 'vitest';
import { cardStatus, setupCorpusDashboard } from '../src/corpus-dashboard.ts';
import { ResourceStates } from '../src/resource-state.ts';
import type { Corpus } from '../src/types.ts';

interface DashboardElement {
  hidden: boolean;
  textContent: string;
  attributes: Record<string, string>;
  onclick?: (event: Partial<MouseEvent> & { preventDefault(): void }) => void;
  setAttribute(name: string, value: string): void;
}

function harness() {
  const elements = new Map<string, DashboardElement>();
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false,
      textContent: selector.endsWith('-detail') ? 'Default detail' : '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    return elements.get(selector)!;
  };
  vi.stubGlobal('document', { querySelector: get });
  let selected: Corpus = 'nfcorpus';
  const chooser = {
    selected: () => selected,
    choose: vi.fn((value: Corpus) => { selected = value; }),
    openSetup: vi.fn(),
  };
  const states = new ResourceStates();
  const dashboard = setupCorpusDashboard(states, chooser);
  return { get, chooser, states, dashboard, card: (corpus: Corpus) => get(`.corpus-card[data-corpus="${corpus}"]`) };
}

afterEach(() => vi.unstubAllGlobals());

it('maps each resource phase to a green, red, or pending light', () => {
  expect(cardStatus('nfcorpus', 'ready', '').light).toBe('available');
  expect(cardStatus('msmarco', 'saved', '').light).toBe('available');
  expect(cardStatus('msmarco', 'missing', '')).toMatchObject({ light: 'unavailable', label: 'Not downloaded' });
  expect(cardStatus('nfcorpus', 'missing', '')).toMatchObject({ light: 'unavailable', label: 'Not set up' });
  expect(cardStatus('msmarco', 'downloading', 'Downloading index: 1.00 / 3.35 GB'))
    .toMatchObject({ light: 'pending', detail: 'Downloading index: 1.00 / 3.35 GB' });
  expect(cardStatus('nfcorpus', 'error', 'Boom')).toMatchObject({ light: 'unavailable', setup: 'Fix in Settings' });
});

it('guides missing collections to their Settings section and selects a collection from its card', () => {
  const ui = harness();
  ui.states.set('nfcorpus', 'ready', 'Ready');
  ui.states.set('msmarco', 'missing', 'Missing');

  expect(ui.card('nfcorpus').attributes['data-status']).toBe('available');
  expect(ui.card('nfcorpus').attributes['data-selected']).toBe('true');
  expect(ui.get('#nfcorpus-dashboard-selected').hidden).toBe(false);
  expect(ui.get('#nfcorpus-dashboard-use').attributes['aria-pressed']).toBe('true');
  expect(ui.get('#msmarco-dashboard-use').attributes['aria-pressed']).toBe('false');
  expect(ui.get('#nfcorpus-dashboard-setup').hidden).toBe(true);

  expect(ui.card('msmarco').attributes['data-status']).toBe('unavailable');
  expect(ui.get('#msmarco-dashboard-status').textContent).toBe('Not downloaded');
  expect(ui.get('#msmarco-dashboard-setup').hidden).toBe(false);
  expect(ui.get('#msmarco-dashboard-setup').textContent).toBe('Download in Settings (3.35 GB) →');
  const preventDefault = vi.fn();
  ui.get('#msmarco-dashboard-setup').onclick?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(ui.chooser.openSetup).toHaveBeenCalledWith('msmarco');

  ui.states.set('msmarco', 'saved', 'Saved');
  expect(ui.card('msmarco').attributes['data-status']).toBe('available');
  ui.get('#msmarco-dashboard-use').onclick?.({ preventDefault() {} });
  expect(ui.chooser.choose).toHaveBeenCalledWith('msmarco');
  expect(ui.card('msmarco').attributes['data-selected']).toBe('true');
  expect(ui.get('#msmarco-dashboard-use').attributes['aria-pressed']).toBe('true');
  expect(ui.get('#nfcorpus-dashboard-use').attributes['aria-pressed']).toBe('false');
  expect(ui.get('#msmarco-dashboard-selected').hidden).toBe(false);
  expect(ui.get('#nfcorpus-dashboard-selected').hidden).toBe(true);
});

it('shows live progress while downloading and restores the default description afterwards', () => {
  const ui = harness();
  ui.states.set('msmarco', 'downloading', 'Downloading index: 1.00 / 3.35 GB (30%)');
  expect(ui.card('msmarco').attributes['data-status']).toBe('pending');
  expect(ui.get('#msmarco-dashboard-detail').textContent).toBe('Downloading index: 1.00 / 3.35 GB (30%)');
  expect(ui.get('#msmarco-dashboard-setup').textContent).toBe('View progress →');
  ui.states.set('msmarco', 'ready', 'Ready');
  expect(ui.get('#msmarco-dashboard-detail').textContent).toBe('Default detail');
});
