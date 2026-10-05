import type { ResourcePhase } from './resource-state.ts';

// First-visit walkthrough of the search page: a dimmed overlay with a cut-out
// around one target at a time, and a pointer card with Back / Next / Skip.

export const TOUR_KEY = 'ragbox-tour-done';
const PAD = 8;
const RADIUS = 16;
const GAP = 16;
const MARGIN = 16;
const MOVE_MS = 420;

export interface Rect { x: number; y: number; w: number; h: number }

export interface TourStep {
  target: () => HTMLElement | null;
  title: string;
  body: (modelPhase: ResourcePhase) => string;
  hint?: string;
  // Highlight only the visible children, not the target's full (stretched) box.
  fitChildren?: boolean;
  // Put the card beside the target (for the sidebar) instead of above or below it.
  placement?: 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: () => document.querySelector<HTMLElement>('.corpus-cards'),
    title: 'Choose a collection',
    body: () => 'Pick what you want to search. NFCorpus covers nutrition and medical research and sets up in under a minute. MS MARCO covers general web knowledge and needs a one-time 3.35 GB download.',
    hint: 'Click a card to select it.',
  },
  {
    target: () => document.querySelector<HTMLElement>('.model-note'),
    title: 'Add cited answers (optional)',
    body: phase => phase === 'ready' || phase === 'generating'
      ? 'The answer model is already installed. It reads your search results and writes a short answer that cites them.'
      : phase === 'unsupported'
        ? 'This browser can’t run the answer model, so you’ll get search results without an LLM answer. Search itself works normally.'
        : 'The answer model (about 1.84 GB, downloaded once) is only used to write an LLM answer that cites your search results. You can skip it: search works without it, you just won’t get a written answer.',
    hint: 'Download it here now, or later in Settings.',
    fitChildren: true,
  },
  {
    target: () => document.querySelector<HTMLElement>('#nav-history'),
    title: 'Continue a saved chat',
    body: () => 'History saves your conversations and their sources in this browser. Use Continue chat to reopen one and ask another question. Search the list when it gets long.',
    hint: 'Find it in the sidebar.',
    placement: 'right',
  },
  {
    target: () => document.querySelector<HTMLElement>('#nav-setup'),
    title: 'Details live in Settings',
    body: () => 'Open Settings for the details behind search: each collection’s index (whether it’s ready, its size, and its saved files) and the answer model, an LLM that runs in your browser. You can install, reinstall, or delete either one there.',
    hint: 'Open it anytime from the sidebar.',
    placement: 'right',
  },
  {
    target: () => document.querySelector<HTMLElement>('.chat-input-row') ?? document.querySelector<HTMLElement>('.collection-panel:not([hidden]) .search-row'),
    title: 'Ask a question',
    body: () => 'Type a question and press Enter. Then ask follow-up questions in the same chat. Open Sources beneath a reply to check its evidence. Shift+Enter adds a new line.',
  },
];

export function tourSeen(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()) {
  try { return storage?.getItem(TOUR_KEY) === '1'; } catch { return false; }
}

function markSeen(storage: Pick<Storage, 'setItem'> | undefined = safeStorage()) {
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

const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const mix = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});

export function setupTour({ modelPhase, onClose }: { modelPhase: () => ResourcePhase; onClose?: () => void }) {
  const doc = document;
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let root: HTMLElement | null = null;
  let index = 0;
  // The highlight moves to the next step at once; the card text swaps after its fade.
  let holeIndex = 0;
  let frame = 0;
  let shown: Rect | null = null;
  let from: Rect | null = null;
  let moveStart = 0;
  const cleanups: (() => void)[] = [];

  function holeFor(element: HTMLElement, fitChildren = false): Rect | null {
    const boxes = (fitChildren ? [...element.children] : [element])
      .map(child => child.getBoundingClientRect())
      .filter(box => box.width || box.height);
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return { x: left - PAD, y: top - PAD, w: right - left + PAD * 2, h: bottom - top + PAD * 2 };
  }

  function build() {
    const svgNS = 'http://www.w3.org/2000/svg';
    root = doc.createElement('div');
    root.className = 'tour';
    const svg = doc.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'tour-overlay');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(svgNS, 'path');
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);
    const ring = doc.createElement('div');
    ring.className = 'tour-ring';
    const card = doc.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.setAttribute('aria-describedby', 'tour-body');
    card.innerHTML = `
      <span class="tour-arrow" aria-hidden="true"></span>
      <div class="tour-progress"><span id="tour-step"></span><span class="tour-dots" aria-hidden="true">${TOUR_STEPS.map(() => '<i></i>').join('')}</span></div>
      <h2 id="tour-title"></h2>
      <p id="tour-body"></p>
      <p class="tour-hint" id="tour-hint"></p>
      <div class="tour-actions">
        <button type="button" class="tour-skip">Skip tour</button>
        <span class="tour-nav"><button type="button" class="tour-back">Back</button><button type="button" class="tour-next primary">Next</button></span>
      </div>`;
    root.append(svg, ring, card);
    doc.body.append(root);
    card.querySelector<HTMLButtonElement>('.tour-skip')!.onclick = () => close();
    card.querySelector<HTMLButtonElement>('.tour-back')!.onclick = () => go(index - 1);
    card.querySelector<HTMLButtonElement>('.tour-next')!.onclick = () => index === TOUR_STEPS.length - 1 ? finish() : go(index + 1);
  }

  function render() {
    if (!root) return;
    const step = TOUR_STEPS[index];
    const card = root.querySelector<HTMLElement>('.tour-card')!;
    const next = card.querySelector<HTMLButtonElement>('.tour-next')!;
    card.querySelector('#tour-step')!.textContent = `Step ${index + 1} of ${TOUR_STEPS.length}`;
    card.querySelectorAll('.tour-dots i').forEach((dot, i) => dot.classList.toggle('on', i <= index));
    card.querySelector('#tour-title')!.textContent = step.title;
    card.querySelector('#tour-body')!.textContent = step.body(modelPhase());
    const hint = card.querySelector<HTMLElement>('#tour-hint')!;
    hint.textContent = step.hint ?? '';
    hint.hidden = !step.hint;
    card.querySelector<HTMLButtonElement>('.tour-back')!.hidden = index === 0;
    next.textContent = index === TOUR_STEPS.length - 1 ? 'Start chatting' : 'Next';
    next.focus({ preventScroll: true });
  }

  function go(next: number) {
    if (!root || next < 0 || next >= TOUR_STEPS.length) return;
    const target = TOUR_STEPS[next].target();
    if (!target) { close(); return; }
    const card = root.querySelector<HTMLElement>('.tour-card')!;
    const swap = () => {
      index = next;
      render();
      card.classList.remove('is-switching');
    };
    holeIndex = next;
    from = shown;
    moveStart = performance.now();
    const box = target.getBoundingClientRect();
    if (box.top < 72 || box.bottom > window.innerHeight - 72) {
      target.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
    if (reduceMotion() || !shown) swap();
    else {
      card.classList.add('is-switching');
      setTimeout(swap, 160);
    }
  }

  // Follow the target every frame so scrolling, resizing, and layout changes stay aligned.
  function tick() {
    if (!root) return;
    // rAF timestamps can precede moveStart; a negative t would push the highlight past its start.
    const now = performance.now();
    const target = TOUR_STEPS[holeIndex].target();
    // Leaving the search page (for example by opening Settings) ends the tour.
    if (doc.querySelector<HTMLElement>('#search-view')?.hidden) { close(); return; }
    const live = target && !target.closest('[hidden]') ? holeFor(target, TOUR_STEPS[holeIndex].fitChildren) : null;
    if (!live) { close(); return; }
    const t = from && !reduceMotion() ? Math.min(1, Math.max(0, (now - moveStart) / MOVE_MS)) : 1;
    const hole = from && t < 1 ? mix(from, live, ease(t)) : live;
    if (t >= 1) from = null;
    shown = hole;
    const view = { w: window.innerWidth, h: window.innerHeight };
    const svg = root.querySelector('svg')!;
    svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
    svg.querySelector('path')!.setAttribute('d', overlayPath(view.w, view.h, hole));
    const ring = root.querySelector<HTMLElement>('.tour-ring')!;
    ring.style.transform = `translate(${hole.x}px, ${hole.y}px)`;
    ring.style.width = `${hole.w}px`;
    ring.style.height = `${hole.h}px`;
    const card = root.querySelector<HTMLElement>('.tour-card')!;
    const place = placeCard(hole, { w: card.offsetWidth, h: card.offsetHeight }, view, TOUR_STEPS[holeIndex].placement);
    card.style.transform = `translate(${place.x}px, ${place.y}px)`;
    card.dataset.side = place.side;
    card.style.setProperty('--arrow-at', `${place.arrow}px`);
    frame = requestAnimationFrame(tick);
  }

  function start() {
    if (root) return;
    build();
    index = 0;
    holeIndex = 0;
    shown = null;
    from = null;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    // Choosing a collection card is the action step 1 asks for, so move on.
    const onCard = (event: Event) => {
      if (index === 0 && (event.target as Element | null)?.closest?.('.corpus-select')) go(1);
    };
    // Running a search means the user has what they need.
    const onSubmit = () => finish(false);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('click', onCard);
    doc.addEventListener('submit', onSubmit, true);
    cleanups.push(
      () => doc.removeEventListener('keydown', onKey),
      () => doc.removeEventListener('click', onCard),
      () => doc.removeEventListener('submit', onSubmit, true),
    );
    go(0);
    requestAnimationFrame(() => root?.classList.add('is-open'));
    frame = requestAnimationFrame(tick);
  }

  function close() {
    if (!root) return;
    markSeen();
    cancelAnimationFrame(frame);
    for (const cleanup of cleanups.splice(0)) cleanup();
    const leaving = root;
    root = null;
    leaving.classList.remove('is-open');
    setTimeout(() => leaving.remove(), reduceMotion() ? 0 : 260);
    onClose?.();
  }

  function finish(focusSearch = true) {
    const input = doc.querySelector<HTMLElement>('#chat-query') ?? doc.querySelector<HTMLInputElement>('.collection-panel:not([hidden]) input[type=search]');
    close();
    if (focusSearch) input?.focus();
  }

  return { start, close, get active() { return root !== null; } };
}
