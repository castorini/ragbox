import { it, expect, vi, afterEach } from 'vitest';
import { setupSearchGuidance } from '../src/search-guidance.js';
afterEach(() => vi.unstubAllGlobals());
it('explains initial setup, saved-index reopening, and removes guidance when enabled', () => {
  const nodes = new Map(); const updates = [];
  vi.stubGlobal('document', { querySelector(id) {
    if (!nodes.has(id)) nodes.set(id, { disabled: true, textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() });
    return nodes.get(id);
  } });
  vi.stubGlobal('MutationObserver', class { constructor(fn) { updates.push(fn); } observe() {} });
  document.querySelector('#status').textContent = 'Opening database…';
  setupSearchGuidance();
  expect(nodes.get('#marco-help').textContent).toContain('wait for the database');
  nodes.get('#status').textContent = 'Ready.';
  nodes.get('#marco-status').textContent = 'Download or reopen the index to start searching.';
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help').textContent).toContain('Retry opening index');
  nodes.get('#marco-status').textContent = 'Download the index once to start searching.';
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help').textContent).toContain('Download & open index');
  nodes.get('#marco-search').disabled = false;
  updates.forEach(fn => fn());
  expect(nodes.get('#marco-help').hidden).toBe(true);
});

it('explains how to open a downloaded HTML file when browser storage is unavailable', () => {
  const nodes = new Map();
  vi.stubGlobal('location', { protocol: 'file:' });
  vi.stubGlobal('document', { querySelector(id) {
    if (!nodes.has(id)) nodes.set(id, { disabled: true, textContent: '', setAttribute: vi.fn(), removeAttribute: vi.fn() });
    return nodes.get(id);
  } });
  vi.stubGlobal('MutationObserver', class { observe() {} });
  setupSearchGuidance();
  expect(nodes.get('#marco-help').textContent).toContain('localhost');
  expect(nodes.get('#marco-help').textContent).not.toContain('Reload');
  expect(nodes.get('#fts-help').textContent).toContain('localhost');
});
