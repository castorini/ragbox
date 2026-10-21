// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { uiHarness, evidence } from './react-fixtures.tsx';
import { EXAMPLE_QUERIES } from '../src/example-queries.ts';
import { sourceAnchor } from '../src/lib/presentation.ts';
const composer = () => screen.getByRole('combobox', { name: 'Ask your documents' });
function seed(h: Awaited<ReturnType<typeof uiHarness>>, answer = 'Nuts may lower LDL [MED-1].') {
  let turn!: ReturnType<typeof h.runtime.conversations.append>;
  act(() => {
    turn = h.runtime.conversations.append('Do nuts lower cholesterol?', [], false);
    h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { phase: 'generating', stage: 'generate', answer, results: [evidence], includedIds: ['MED-1'], thinkingEffort: 'off' });
  });
  return turn;
}
it('keeps sources, DOM identity, composer focus and drafts stable during streaming', async () => {
  const h = await uiHarness(); const turn = seed(h);
  const summary = screen.getByText('Sources (1)'), details = summary.closest('details')!;
  fireEvent.click(summary); expect(details.open).toBe(true);
  composer().focus(); fireEvent.change(composer(), { target: { value: 'a draft' } });
  const article = screen.getByRole('article');
  act(() => h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { answer: 'Updated answer [MED-1].' }, true));
  expect(screen.getByRole('article')).toBe(article); expect(details.open).toBe(true);
  expect(composer()).toHaveFocus(); expect(composer()).toHaveValue('a draft');
  expect(screen.getByText('Updated answer', { exact: false })).toBeVisible();
});
it('sends with Enter, retains Shift+Enter and ignores IME Enter', async () => {
  const h = await uiHarness();
  fireEvent.change(composer(), { target: { value: 'Do nuts lower cholesterol?' } });
  fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true }); expect(h.retrieve).not.toHaveBeenCalled();
  fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true }); expect(h.retrieve).not.toHaveBeenCalled();
  fireEvent.keyDown(composer(), { key: 'Enter' });
  await waitFor(() => expect(h.retrieve).toHaveBeenCalledOnce()); expect(composer()).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Stop current reply' })).toBeEnabled();
});
it('blocks oversized and blank questions while leaving the draft editable', async () => {
  const h = await uiHarness();
  fireEvent.change(composer(), { target: { value: 'x'.repeat(501) } });
  expect(screen.getByRole('alert')).toHaveTextContent('501 characters');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  fireEvent.keyDown(composer(), { key: 'Enter' }); expect(h.retrieve).not.toHaveBeenCalled();
  fireEvent.change(composer(), { target: { value: '   ' } }); expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
});
it('offers keyboard-accessible starter questions during a chat and submits the selected one', async () => {
  const h = await uiHarness(); const turn = seed(h);
  act(() => h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { phase: 'complete' }));
  fireEvent.focus(composer()); fireEvent.keyDown(composer(), { key: 'ArrowDown' });
  expect(composer()).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(composer(), { key: 'Enter' });
  await waitFor(() => expect(h.runtime.conversations.current().turns.at(-1)?.question).toBe(EXAMPLE_QUERIES.nfcorpus[0]));
});
it('links only included evidence and renders model HTML as text', async () => {
  const h = await uiHarness(); const turn = seed(h, '<img src=x onerror=alert(1)> [MED-1] [UNTRUSTED]');
  const article = screen.getByRole('article');
  expect(article.querySelector('img')).toBeNull();
  expect(within(article).getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
  const link = within(article).getByRole('link', { name: '[MED-1]' });
  expect(link).toHaveAttribute('href', `#${sourceAnchor(h.runtime.conversations.current().id, turn.id, 'MED-1')}`);
  expect(within(article).queryByRole('link', { name: '[UNTRUSTED]' })).toBeNull();
  fireEvent.click(link); expect(screen.getByText('Sources (1)').closest('details')).toHaveAttribute('open');
  expect(document.getElementById(sourceAnchor(h.runtime.conversations.current().id, turn.id, 'MED-1'))).toHaveFocus();
});
it('copies the answer without reasoning and clears feedback when the answer changes', async () => {
  const h = await uiHarness(); const turn = seed(h);
  const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  act(() => h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { thinking: 'Private reasoning', phase: 'complete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Answer copied' })).toBeVisible());
  expect(writeText).toHaveBeenCalledWith('Nuts may lower LDL [MED-1].');
  act(() => h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { answer: 'Replacement' }));
  expect(screen.getByRole('button', { name: 'Copy answer' })).toBeVisible();
});
it('keeps generation running while navigating to Settings and back', async () => {
  const h = await uiHarness(); fireEvent.change(composer(), { target: { value: 'Nuts?' } }); fireEvent.keyDown(composer(), { key: 'Enter' });
  await waitFor(() => expect(h.worker.messages.some(m => m.type === 'generate')).toBe(true));
  const request = h.worker.messages.find(m => m.type === 'generate')!;
  fireEvent.click(screen.getByRole('navigation', { name: 'Main navigation' }).querySelector('[aria-label="Settings"]')!);
  expect(h.runtime.chat.running).toBe(true);
  act(() => h.worker.emit({ type: 'answer-delta', requestId: request.requestId!, text: 'Answer while in Settings [MED-1].' }));
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Chat' }));
  expect(screen.getByText('Answer while in Settings', { exact: false })).toBeVisible(); expect(h.workerFactory).toHaveBeenCalledOnce();
});
it('stops generation and ignores late worker output', async () => {
  const h = await uiHarness(); fireEvent.change(composer(), { target: { value: 'Nuts?' } }); fireEvent.keyDown(composer(), { key: 'Enter' });
  await waitFor(() => expect(h.worker.messages.some(m => m.type === 'generate')).toBe(true));
  const request = h.worker.messages.find(m => m.type === 'generate')!;
  fireEvent.click(screen.getByRole('button', { name: 'Stop current reply' }));
  act(() => h.worker.emit({ type: 'answer-delta', requestId: request.requestId!, text: 'Stale answer' }));
  expect(screen.queryByText('Stale answer')).toBeNull(); expect(h.runtime.conversations.current().turns.at(-1)?.phase).toBe('stopped');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
});
it('keeps keyword retrieval available without WebGPU', async () => {
  const h = await uiHarness({ supported: false });
  fireEvent.change(composer(), { target: { value: 'Nuts?' } }); fireEvent.keyDown(composer(), { key: 'Enter' });
  await waitFor(() => expect(h.runtime.conversations.current().turns.at(-1)?.phase).toBe('blocked'));
  expect(screen.getByText('Sources (1)')).toBeVisible(); expect(screen.getByText(/Showing keyword search results/)).toBeVisible();
  expect(h.workerFactory).not.toHaveBeenCalled();
});
it('does not scroll on answer deltas after a newly submitted turn has scrolled', async () => {
  const h = await uiHarness(); const turn = seed(h);
  await new Promise(resolve => setTimeout(resolve, 40));
  const scrolls = vi.mocked(window.scrollTo).mock.calls.length;
  act(() => h.runtime.conversations.update(h.runtime.conversations.current().id, turn.id, { answer: 'Streaming more' }, true));
  await new Promise(resolve => setTimeout(resolve, 40)); expect(vi.mocked(window.scrollTo).mock.calls).toHaveLength(scrolls);
});
it('preserves drafts independently when changing collections', async () => {
  const h = await uiHarness(); fireEvent.change(composer(), { target: { value: 'NFCorpus draft' } });
  act(() => h.runtime.chat.select('msmarco')); expect(composer()).toHaveValue('');
  fireEvent.change(composer(), { target: { value: 'MS MARCO draft' } }); act(() => h.runtime.chat.select('nfcorpus'));
  expect(composer()).toHaveValue('NFCorpus draft');
});
it('shows persistence errors without losing the draft', async () => {
  const h = await uiHarness(); fireEvent.change(composer(), { target: { value: 'Keep this' } });
  act(() => h.runtime.conversations.state.setState({ unsaved: 'This chat could not be saved.' }));
  expect(screen.getByText('This chat could not be saved.')).toBeVisible(); expect(composer()).toHaveValue('Keep this');
});
