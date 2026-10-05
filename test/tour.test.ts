import { it, expect } from 'vitest';
import { overlayPath, placeCard, TOUR_STEPS, tourSeen, TOUR_KEY } from '../src/tour.ts';

const view = { w: 1280, h: 800 };
const card = { w: 360, h: 200 };

it('places the card below the target when there is room, pointing at its center', () => {
  const place = placeCard({ x: 300, y: 100, w: 760, h: 60 }, card, view);
  expect(place.side).toBe('below');
  expect(place.y).toBe(176);
  expect(place.x).toBe(680 - 180);
  expect(place.arrow).toBe(180);
});

it('flips above a target near the bottom and stays inside the viewport', () => {
  const place = placeCard({ x: 1100, y: 640, w: 160, h: 120 }, card, view);
  expect(place.side).toBe('above');
  expect(place.y).toBe(640 - 16 - 200);
  expect(place.x).toBe(1280 - 360 - 16);
  expect(place.arrow).toBeLessThanOrEqual(360 - 22);
});

it('cuts a rounded hole out of the full-screen overlay', () => {
  expect(overlayPath(100, 50, null)).toBe('M0 0H100V50H0Z');
  const path = overlayPath(100, 50, { x: 10, y: 10, w: 40, h: 20 });
  expect(path.startsWith('M0 0H100V50H0ZM20 10')).toBe(true);
  expect(path.match(/A/g)).toHaveLength(4);
});

it('explains the optional model step according to what this browser can do', () => {
  const model = TOUR_STEPS[1];
  expect(model.body('idle')).toMatch(/1\.84 GB.*skip it/i);
  expect(model.body('ready')).toMatch(/already installed/);
  expect(model.body('unsupported')).toMatch(/can’t run the answer model/);
  expect(TOUR_STEPS.map(step => step.title)).toEqual(['Choose a collection', 'Add cited answers (optional)', 'Continue a saved chat', 'Details live in Settings', 'Ask a question']);
  expect(TOUR_STEPS[2].body('idle')).toMatch(/conversations.*sources/);
  expect(TOUR_STEPS[3].body('idle')).toMatch(/index.*answer model/);
});

it('remembers that the tour was completed or skipped', () => {
  expect(tourSeen({ getItem: () => null })).toBe(false);
  expect(tourSeen({ getItem: key => key === TOUR_KEY ? '1' : null })).toBe(true);
  expect(tourSeen({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
});

it('puts the Settings card beside the sidebar, pointing at the icon', () => {
  const icon = { x: 1, y: 449, w: 78, h: 78 };
  const place = placeCard(icon, card, view, 'right');
  expect(place.side).toBe('right');
  expect(place.x).toBe(1 + 78 + 16);
  expect(place.y).toBe(488 - 100);
  expect(place.arrow).toBe(100);
  expect(placeCard({ x: 1100, y: 400, w: 160, h: 60 }, card, view, 'right').side).not.toBe('right');
});
