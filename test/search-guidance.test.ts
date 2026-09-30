import { it, expect, vi, afterEach } from 'vitest';
import { setupSearchGuidance } from '../src/search-guidance.ts';
afterEach(() => vi.unstubAllGlobals());
it('explains initial setup, saved-index reopening, and removes guidance when enabled', () => {
  type FakeNode = { disabled: boolean; textContent: string; hidden?: boolean; setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> };
  const nodes = new Map<string, FakeNode>(); const updates: Array<() => void> = [];
  vi.stubGlobal('document', { querySelector(id: string) {
    if (!nodes.has(id)) nodes.set(id, { disabled: true, textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() });
    return nodes.get(id);
  } });
  vi.stubGlobal('MutationObserver', class { constructor(fn: () => void) { updates.push(fn); } observe() {} });
  document.querySelector('#status');
  nodes.get('#status')!.textContent = 'Opening database…';
  setupSearchGuidance();
  expect(nodes.get('#marco-help')!.textContent).toContain('wait for the database');
  nodes.get('#status')!.textContent = 'Ready.';
  nodes.get('#marco-status')!.textContent = 'Download or reopen the index to start searching.';
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help')!.textContent).toContain('Retry opening index');
  nodes.get('#marco-status')!.textContent = 'Download the index once to start searching.';
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help')!.textContent).toContain('Download & open index');
  nodes.get('#marco-search')!.disabled = false;
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help')!.hidden).toBe(true);
});
