import { it, expect } from 'vitest';
import { cardStatus, settingsCollectionStatus } from '../src/lib/presentation.ts';

it('maps each resource phase to a green, red, or pending light', () => {
  expect(cardStatus('nfcorpus', 'ready', '').light).toBe('available');
  expect(cardStatus('msmarco', 'saved', '').light).toBe('available');
  expect(cardStatus('msmarco', 'missing', '')).toMatchObject({ light: 'unavailable', label: 'Not downloaded' });
  expect(cardStatus('nfcorpus', 'missing', '')).toMatchObject({ light: 'unavailable', label: 'Not prepared' });
  expect(cardStatus('msmarco', 'downloading', 'Downloading index: 1.00 / 3.35 GB'))
    .toMatchObject({ light: 'pending', detail: 'Downloading index: 1.00 / 3.35 GB' });
  expect(cardStatus('nfcorpus', 'error', 'Boom')).toMatchObject({ light: 'unavailable', setup: 'Fix in Settings' });
});

it('uses plain-language labels for opening, setup, and unavailable collections', () => {
  expect(settingsCollectionStatus('nfcorpus', { phase: 'preparing', message: 'Building index…' }))
    .toEqual({ label: 'Setting up…', detail: 'Building index…' });
  expect(settingsCollectionStatus('msmarco', { phase: 'opening', message: 'Opening index…' }).label).toBe('Opening…');
  expect(settingsCollectionStatus('msmarco', { phase: 'missing', message: '' }).label).toBe('Not downloaded');
  expect(settingsCollectionStatus('nfcorpus', { phase: 'unsupported', message: '' }).label).toBe('Unavailable');
});
