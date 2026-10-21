import type { ResourcePhase } from './resource-state.ts';
import { HISTORY_ENABLED } from './features.ts';

// First-visit walkthrough of the search page: a dimmed overlay with a cut-out
// around one target at a time, and a pointer card with Back / Next / Skip.

export const TOUR_KEY = 'ragbox-tour-done';
const RADIUS = 16;
const GAP = 16;
const MARGIN = 16;

export interface Rect { x: number; y: number; w: number; h: number }

export interface TourStep {
  target: 'collections' | 'model' | 'history' | 'settings' | 'guide' | 'composer';
  title: string;
  body: (modelPhase: ResourcePhase) => string;
  hint?: string;
  // Highlight only the visible children, not the target's full (stretched) box.
  fitChildren?: boolean;
  // Put the card beside the target (for the sidebar) instead of above or below it.
  placement?: 'right';
  // Only shown while the History feature is on.
  history?: boolean;
}

const ALL_STEPS: TourStep[] = [
  {
    target: 'collections',
    title: 'Choose a collection',
    body: () => 'Pick what you want to search. NFCorpus covers nutrition and medical research and sets up in under a minute. MS MARCO covers general web knowledge and needs a one-time 3.35 GB download.',
    hint: 'Click a card to select it.',
  },
  {
    target: 'model',
    title: 'Add cited answers',
    body: phase => phase === 'ready' || phase === 'generating'
      ? 'The answer model is already installed. It reads your search results and writes a short answer that cites them.'
      : phase === 'unsupported'
        ? 'This browser can’t run the answer model, so you’ll get search results without an LLM answer. Search itself works normally.'
        : 'The answer model (about 1.84 GB, downloaded once) reads your search results and writes an LLM answer that cites them.',
    hint: 'Download it here now, or later in Settings.',
    fitChildren: true,
  },
  {
    target: 'history',
    title: 'Continue a saved chat',
    body: () => 'History saves your conversations and their sources in this browser. Use Continue chat to reopen one and ask another question. Search the list when it gets long.',
    hint: 'Find it in the sidebar.',
    placement: 'right',
    history: true,
  },
  {
    target: 'settings',
    title: 'Details live in Settings',
    body: () => 'Open Settings for the details behind search: each collection’s index (whether it’s ready, its size, and its saved files) and the answer model, an LLM that runs in your browser. You can install, reinstall, or delete either one there.',
    hint: 'Open it anytime from the sidebar.',
    placement: 'right',
  },
  {
    target: 'guide',
    title: 'Learn more in How it works',
    body: () => 'How it works walks through a first search step by step, with screenshots, and explains what happens on your device: how questions become keywords, how results are ranked, and where your data is saved.',
    hint: 'Open it anytime from the sidebar.',
    placement: 'right',
  },
  {
    target: 'composer',
    title: 'Ask a question',
    body: () => 'Type a question and press Enter. Then ask follow-up questions in the same chat. Open Sources beneath a reply to check its evidence. Shift+Enter adds a new line.',
  },
];

export function tourSteps(historyEnabled = HISTORY_ENABLED) {
  return ALL_STEPS.filter(step => historyEnabled || !step.history);
}

export const TOUR_STEPS = tourSteps();

export function tourSeen(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()) {
  try { return storage?.getItem(TOUR_KEY) === '1'; } catch { return false; }
}

export function markTourSeen(storage: Pick<Storage, 'setItem'> | undefined = safeStorage()) {
  try { storage?.setItem(TOUR_KEY, '1'); } catch { /* storage blocked: the tour may show again */ }
}

function safeStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

// SVG path for the full screen with a rounded-rectangle hole (even-odd fill).
export function overlayPath(width: number, height: number, hole: Rect | null) {
  const screen = `M0 0H${width}V${height}H0Z`;
  if (!hole) return screen;
  const r = Math.min(RADIUS, hole.w / 2, hole.h / 2);
  const { x, y, w, h } = hole;
  return `${screen}M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}`
    + `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}`
    + `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

// Place the card below the hole when it fits, otherwise above; keep it on screen.
// A 'right' preference puts it beside the hole, used for the sidebar.
export function placeCard(hole: Rect, card: { w: number; h: number }, view: { w: number; h: number }, prefer?: 'right') {
  const besideX = hole.x + hole.w + GAP;
  if (prefer === 'right' && besideX + card.w <= view.w - MARGIN) {
    const middle = hole.y + hole.h / 2;
    const y = Math.max(MARGIN, Math.min(middle - card.h / 2, view.h - card.h - MARGIN));
    return { x: besideX, y, side: 'right' as const, arrow: Math.max(22, Math.min(middle - y, card.h - 22)) };
  }
  const below = hole.y + hole.h + GAP;
  const fitsBelow = below + card.h <= view.h - MARGIN;
  const fitsAbove = hole.y - GAP - card.h >= MARGIN;
  const side: 'below' | 'above' | 'right' = fitsBelow || !fitsAbove ? 'below' : 'above';
  const rawY = side === 'below' ? below : hole.y - GAP - card.h;
  const y = Math.max(MARGIN, Math.min(rawY, view.h - card.h - MARGIN));
  const center = hole.x + hole.w / 2;
  const x = Math.max(MARGIN, Math.min(center - card.w / 2, view.w - card.w - MARGIN));
  const arrow = Math.max(22, Math.min(center - x, card.w - 22));
  return { x, y, side, arrow };
}

