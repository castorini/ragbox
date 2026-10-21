import { createContext, createRef, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../components/ui/button.tsx';
import { markTourSeen, overlayPath, placeCard, tourSeen, tourSteps, type Rect, type TourStep } from '../tour-geometry.ts';
import { useConversations, useResources } from './context.tsx';
import { useRoute } from './navigation.tsx';
import { currentConversation } from '../conversations.ts';
type Target = TourStep['target'];
interface TourContextValue { targets: Record<Target, RefObject<HTMLElement | null>>; start(): void; close(focus?: boolean): void; active: boolean }
const TourContext = createContext<TourContextValue | null>(null);
export function useTourTarget(target: Target) { const tour = useContext(TourContext); if (!tour) throw new Error('TourProvider is missing.'); return tour.targets[target]; }
export function useTour() { return useContext(TourContext)!; }
export function TourProvider({ children, historyEnabled }: { children: ReactNode; historyEnabled: boolean }) {
  const targets = useMemo(() => Object.fromEntries(['collections', 'model', 'history', 'settings', 'guide', 'composer'].map(key => [key, createRef<HTMLElement>()])) as TourContextValue['targets'], []);
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const route = useRoute();
  const initialized = useConversations(s => s.initialized);
  const turns = useConversations(s => currentConversation(s).turns.length);
  const phase = useResources(s => s.resources.model.phase);
  const steps = useMemo(() => tourSteps(historyEnabled), [historyEnabled]);
  const start = useCallback(() => { previousFocus.current = document.activeElement as HTMLElement; setIndex(0); setActive(true); }, []);
  const close = useCallback((focus = false) => {
    markTourSeen(); setActive(false);
    const target = focus ? targets.composer.current?.querySelector<HTMLElement>('textarea') : previousFocus.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [targets]);
  useEffect(() => {
    if (!initialized || route.view !== 'search' || turns || tourSeen()) return;
    const timer = setTimeout(start, 700); return () => clearTimeout(timer);
  }, [initialized, route.view, turns, start]);
  useEffect(() => { if (active && route.view !== 'search') close(); }, [active, route.view, close]);
  return <TourContext value={{ targets, start, close, active }}>{children}{active && <TourOverlay steps={steps} index={index} setIndex={setIndex} phase={phase} />}</TourContext>;
}
function TourOverlay({ steps, index, setIndex, phase }: { steps: TourStep[]; index: number; setIndex(index: number): void; phase: Parameters<TourStep['body']>[0] }) {
  const { targets, close } = useTour();
  const card = useRef<HTMLDivElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const shown = useRef<Rect | null>(null);
  const [layout, setLayout] = useState<{ hole: Rect; width: number; height: number; x: number; y: number; side: string; arrow: number }>();
  const step = steps[index];
  useLayoutEffect(() => {
    nextButton.current?.focus({ preventScroll: true });
    const target = targets[step.target].current;
    if (target) { const box = target.getBoundingClientRect(); if (box.top < 72 || box.bottom > innerHeight - 72) target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    let frame = 0;
    const from = shown.current; const started = performance.now();
    const tick = () => {
      const element = targets[step.target].current;
      const boxes = element && !element.closest('[hidden]') ? (step.fitChildren ? [...element.children] : [element]).map(e => e.getBoundingClientRect()).filter(r => r.width || r.height) : [];
      if (!boxes.length) {
        if (index + 1 < steps.length) setIndex(index + 1); else close(true);
        return;
      }
      const left = Math.min(...boxes.map(r => r.left)), top = Math.min(...boxes.map(r => r.top));
      const live = { x: left - 8, y: top - 8, w: Math.max(...boxes.map(r => r.right)) - left + 16, h: Math.max(...boxes.map(r => r.bottom)) - top + 16 };
      const raw = from && !matchMedia('(prefers-reduced-motion: reduce)').matches ? Math.min(1, Math.max(0, (performance.now() - started) / 420)) : 1;
      const t = raw < .5 ? 4 * raw ** 3 : 1 - (-2 * raw + 2) ** 3 / 2;
      const hole = from && t < 1 ? { x: from.x + (live.x - from.x) * t, y: from.y + (live.y - from.y) * t, w: from.w + (live.w - from.w) * t, h: from.h + (live.h - from.h) * t } : live;
      shown.current = hole;
      const place = placeCard(hole, { w: card.current?.offsetWidth ?? 340, h: card.current?.offsetHeight ?? 240 }, { w: innerWidth, h: innerHeight }, step.placement);
      const value = { hole, width: innerWidth, height: innerHeight, ...place };
      setLayout(previous => previous && JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step, targets, close, index, steps.length, setIndex]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const submit = () => close();
    const click = (e: MouseEvent) => { if (index === 0 && (e.target as Element)?.closest?.('[data-collection-select]')) setIndex(1); };
    document.addEventListener('keydown', key); document.addEventListener('submit', submit, true); document.addEventListener('click', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('submit', submit, true); document.removeEventListener('click', click); };
  }, [close, index, setIndex]);
  return createPortal(<div className="tour">
    <svg className="tour-overlay" aria-hidden="true" viewBox={`0 0 ${layout?.width ?? innerWidth} ${layout?.height ?? innerHeight}`}><path fillRule="evenodd" d={overlayPath(layout?.width ?? innerWidth, layout?.height ?? innerHeight, layout?.hole ?? null)} /></svg>
    {layout && <div className="tour-ring" style={{ transform: `translate(${layout.hole.x}px, ${layout.hole.y}px)`, width: layout.hole.w, height: layout.hole.h }} />}
    <div ref={card} className="tour-card" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" data-side={layout?.side} style={{ transform: `translate(${layout?.x ?? 16}px, ${layout?.y ?? 16}px)`, visibility: layout ? 'visible' : 'hidden', '--arrow-at': `${layout?.arrow ?? 22}px` } as React.CSSProperties}>
      <span className="tour-arrow" aria-hidden="true" /><div className="tour-progress"><span>Step {index + 1} of {steps.length}</span><span className="tour-dots" aria-hidden="true">{steps.map((s, i) => <i key={s.target} className={i <= index ? 'on' : ''} />)}</span></div>
      <h2 id="tour-title">{step.title}</h2><p id="tour-body">{step.body(phase)}</p>{step.hint && <p className="tour-hint">{step.hint}</p>}
      <div className="tour-actions"><Button variant="ghost" size="sm" onClick={() => close()}>Skip tour</Button><div className="flex gap-2"><Button variant="outline" size="sm" hidden={index === 0} onClick={() => setIndex(index - 1)}>Back</Button><Button ref={nextButton} size="sm" onClick={() => index === steps.length - 1 ? close(true) : setIndex(index + 1)}>{index === steps.length - 1 ? 'Start chatting' : 'Next'}</Button></div></div>
    </div>
  </div>, document.body);
}
