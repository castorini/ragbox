// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { uiHarness, evidence } from './react-fixtures.tsx';
const navigation = () => screen.getByRole('navigation', { name: 'Main navigation' });
const go = (name: string) => fireEvent.click(within(navigation()).getByRole('link', { name }));
it('keeps query-string routes, focus, titles and browser history behavior', async () => {
  await uiHarness({ url: '/ragbox/?custom=keep' });
  go('Settings'); expect(location.search).toBe('?custom=keep&view=setup');
  expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus(); expect(document.title).toBe('Settings · ragbox');
  go('How it works'); expect(document.title).toBe('How it works · ragbox');
  act(() => history.back()); await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible());
  expect(within(navigation()).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
});
it('opens management panels and preserves Settings deep-link aliases', async () => {
  await uiHarness({ url: '/ragbox/?view=setup#storage-management' });
  expect(document.getElementById('collection-management')).toHaveAttribute('open');
  expect(document.getElementById('collection-management')).toHaveFocus();
});
it('focuses the model action for a direct model setup link', async () => {
  await uiHarness({ ready: false, url: '/ragbox/?view=setup#model' });
  expect(document.getElementById('llm-load')).toHaveFocus();
});
it('keeps the History feature off and falls back to Chat for its URL by default', async () => {
  await uiHarness({ url: '/ragbox/?view=history' });
  expect(within(navigation()).queryByRole('link', { name: 'History' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Ask your documents' })).toBeVisible();
});
it('supports the retained History screen, filtering and continuation when enabled', async () => {
  const h = await uiHarness({ historyEnabled: true });
  act(() => { const t = h.runtime.conversations.append('A question about nuts', [], false); h.runtime.conversations.update(h.runtime.conversations.current().id, t.id, { phase: 'complete', answer: 'An answer', results: [evidence] }); });
  go('History'); expect(screen.getByRole('heading', { name: 'History' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'nonexistent' } });
  expect(screen.getByText('No conversations match your search.')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'nuts' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue chat' }));
  expect(screen.getByRole('combobox', { name: 'Ask your documents' })).toBeVisible();
  expect(h.runtime.conversations.current().turns[0].question).toBe('A question about nuts');
});
it('uses a confirmation dialog for large downloads and cancellation restores focus', async () => {
  const h = await uiHarness();
  act(() => h.runtime.resources.set('msmarco', 'missing', 'Not downloaded.', undefined, undefined, false));
  const button = screen.getByRole('button', { name: 'Download MS MARCO index (3.35 GB)' });
  button.focus(); fireEvent.click(button);
  expect(screen.getByRole('alertdialog')).toHaveTextContent('3.35 GB');
  expect(h.runtime.msmarco!.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(button).toHaveFocus()); expect(h.runtime.msmarco!.download).not.toHaveBeenCalled();
  fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: 'Download index' }));
  await waitFor(() => expect(h.runtime.msmarco!.download).toHaveBeenCalledOnce());
});
it('requires confirmation before deleting saved data and keeps unrelated files read-only', async () => {
  const h = await uiHarness({ url: '/ragbox/?view=setup#collection-management' });
  act(() => h.runtime.storage.state.setState({ supported: true, initialized: true, cacheSupported: true, files: [{ path: 'analytics.duckdb', size: 1024, owned: true }, { path: 'personal.txt', size: 80, owned: false }] }));
  const remove = vi.spyOn(h.runtime.storage, 'remove').mockResolvedValue(undefined);
  expect(screen.getByText('Other origin file')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Delete personal.txt' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete index data' }));
  expect(remove).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete index data' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' })); await waitFor(() => expect(remove).toHaveBeenCalledWith({ kind: 'collections' }));
});
it('blocks destructive actions during active resource operations', async () => {
  const h = await uiHarness({ url: '/ragbox/?view=setup' });
  act(() => { h.runtime.storage.state.setState({ supported: true, initialized: true, files: [{ path: 'analytics.duckdb', size: 1, owned: true }] }); h.runtime.resources.set('nfcorpus', 'preparing', 'Preparing index…'); });
  expect(screen.getByRole('button', { name: 'Delete index data' })).toBeDisabled();
});
it('shows reload recovery after a deletion failure', async () => {
  const h = await uiHarness({ url: '/ragbox/?view=setup' });
  act(() => h.runtime.storage.state.setState({ recovery: true, message: 'Could not remove saved files: Locked.' }));
  expect(screen.getByRole('button', { name: 'Reload to recover' })).toBeVisible();
});
it('restores keyboard focus when the model load control becomes Cancel loading', async () => {
  const h = await uiHarness({ ready: false, url: '/ragbox/?view=setup#model' });
  const load = document.getElementById('llm-load')!; expect(load).toHaveFocus(); fireEvent.click(load);
  await waitFor(() => expect(h.workerFactory).toHaveBeenCalledOnce());
  const cancel = within(document.getElementById('model')!).getByRole('button', { name: /Cancel (download|loading)/ });
  expect(cancel).toHaveFocus(); fireEvent.click(cancel);
  await waitFor(() => expect(document.getElementById('llm-load')).toHaveFocus());
});
it('shows indeterminate model download progress and explicit repair guidance', async () => {
  const h = await uiHarness({ ready: false, url: '/ragbox/?view=setup' });
  await act(() => h.runtime.model.load());
  act(() => h.worker.emit({ type: 'progress', progress: { stage: 'downloading', downloadedBytes: 1000, status: 'progress' } }));
  expect(screen.getByRole('progressbar', { name: 'Model loading progress' })).not.toHaveAttribute('aria-valuenow');
  act(() => h.runtime.model.setCacheAvailability('corrupt'));
  expect(screen.getAllByRole('link', { name: 'Reinstall model' }).length).toBeGreaterThan(0);
});
it('replays the non-modal tour and records completion on Escape', async () => {
  await uiHarness();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 200, y: 200, top: 200, left: 200, right: 800, bottom: 260, width: 600, height: 60, toJSON: () => ({}) });
  fireEvent.click(screen.getByRole('button', { name: 'Take a quick tour' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Choose a collection' })).toBeVisible());
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(localStorage.getItem('ragbox-tour-done')).toBe('1');
});
