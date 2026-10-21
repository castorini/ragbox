import { useEffect, useRef } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Progress } from '../components/ui/progress.tsx';
import { NavLink } from './navigation.tsx';
import { useResources, useRuntime } from './context.tsx';
import { useTourTarget } from './tour.tsx';
export function ModelControls({ settings = false }: { settings?: boolean }) {
  const runtime = useRuntime();
  const state = useResources(s => s.resources.model);
  const shuttingDown = useResources(s => s.shuttingDown);
  const root = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const target = useTourTarget('model');
  const canLoad = ['idle', 'error'].includes(state.phase);
  const loading = state.phase === 'loading';
  const message = state.message || 'Checking model…';
  const action = runtime.model.loadAction();
  useEffect(() => {
    const element = lastFocused.current;
    if (element && root.current?.contains(element) && (element.hidden || element.matches(':disabled') || element.closest('[hidden]'))) root.current.querySelector<HTMLElement>('button:not([hidden]):not(:disabled)')?.focus();
  }, [canLoad, loading]);
  return <div ref={element => { root.current = element; if (!settings) target.current = element; }} className="model-note flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground" onFocusCapture={event => { lastFocused.current = event.target as HTMLElement; }} data-phase={state.phase}>
    <span id={settings ? 'llm-status' : 'model-search-status'} aria-live="off">{message}</span>
    <Button id={settings ? 'llm-load' : 'model-search-load'} size="sm" variant={settings ? 'default' : 'outline'} hidden={!canLoad} disabled={!canLoad || shuttingDown} onClick={() => { void runtime.model.recoverModel(); }}><Download aria-hidden="true" />{action}</Button>
    <Button size="sm" variant="outline" hidden={!loading} disabled={!loading || shuttingDown} onClick={() => runtime.model.cancelLoad()}><LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />{state.model?.stage === 'downloading' ? 'Cancel download' : 'Cancel loading'}</Button>
    {!settings && !['ready', 'generating', 'checking', 'loading'].includes(state.phase) && <NavLink href="?view=setup#model" className="font-semibold underline underline-offset-4">Model settings</NavLink>}
    {state.model?.cache === 'corrupt' && <NavLink href="?view=setup#model-storage" className="font-semibold underline underline-offset-4">Reinstall model</NavLink>}
    {settings && loading && <Progress className="basis-full" aria-label="Model loading progress" />}
  </div>;
}
