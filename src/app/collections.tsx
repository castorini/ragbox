import { useResources, useRuntime, useConversations } from './context.tsx';
import { useConfirm } from './confirmation.tsx';
import { useNavigation, NavLink } from './navigation.tsx';
import { useTourTarget } from './tour.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, Badge, Alert } from '../components/ui/card.tsx';
import { Progress } from '../components/ui/progress.tsx';
import { cardStatus } from '../lib/presentation.ts';
import { cn } from '../lib/utils.ts';
import type { Corpus } from '../types.ts';
export const collectionInfo = {
  nfcorpus: { name: 'NFCorpus', description: 'Nutrition and medical research: 3,633 PubMed articles cited by NutritionFacts.org. Best for health and diet questions.', detail: 'Small · built in your browser in under a minute' },
  msmarco: { name: 'MS MARCO', description: 'General web knowledge: 8.8 million short passages from Bing search results. Best for everyday factual questions.', detail: 'One-time 3.35 GB download' },
};
export function CollectionActions({ corpus, settings = false }: { corpus: Corpus; settings?: boolean }) {
  const runtime = useRuntime(), confirm = useConfirm(), navigation = useNavigation();
  const state = useResources(s => s.resources[corpus]);
  const blocked = useResources(s => s.busy || s.shuttingDown);
  const startupFailed = state.message.startsWith('Startup failed:');
  const disabled = blocked || startupFailed || !runtime[corpus] || ['checking', 'opening', 'preparing', 'unsupported'].includes(state.phase);
  const download = () => confirm({ title: 'Download MS MARCO index?', description: 'Download 3.35 GB into this browser’s storage? This replaces any saved MS MARCO index. Close other RAGbox tabs first.', label: 'Download index', action: () => runtime.msmarco?.download() });
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:break-words [&>button]:py-1.5">
    {corpus === 'nfcorpus' && ['missing', 'error'].includes(state.phase) && !startupFailed && <Button size="sm" disabled={disabled} onClick={() => { void runtime.nfcorpus?.prepare(); }}>{state.phase === 'error' ? 'Retry setup' : 'Prepare NFCorpus'}</Button>}
    {corpus === 'msmarco' && (state.phase === 'missing' || (state.phase === 'error' && state.savedAvailable === false)) && !startupFailed && <Button size="sm" disabled={disabled} onClick={download}>Download MS MARCO index (3.35 GB)</Button>}
    {corpus === 'msmarco' && (state.phase === 'saved' || (state.phase === 'error' && state.savedAvailable !== false)) && !startupFailed && <Button size="sm" disabled={disabled} onClick={() => { void runtime.msmarco?.openSaved(); }}>{state.phase === 'error' ? 'Retry opening collection' : 'Open downloaded collection'}</Button>}
    {state.phase === 'downloading' && <><Progress value={state.progress} aria-label="Index download progress" className="min-w-24 flex-1" /><Button size="sm" variant="outline" disabled={blocked} onClick={() => runtime.msmarco?.cancelDownload()}>Cancel download</Button></>}
    {settings && ['ready', 'saved'].includes(state.phase) && <Button variant="outline" size="sm" disabled={blocked} onClick={() => { runtime.chat.select(corpus); navigation.go('search'); }}>Search {collectionInfo[corpus].name}</Button>}
    {settings && corpus === 'msmarco' && state.savedAvailable && !['downloading', 'opening', 'checking'].includes(state.phase) && <Button size="sm" variant="outline" disabled={disabled} onClick={download}>Replace saved index</Button>}
  </div>;
}
export function CollectionCards() {
  const runtime = useRuntime();
  const selected = useConversations(s => s.selected);
  const target = useTourTarget('collections');
  return <section id="corpus-dashboard" aria-labelledby="corpus-dashboard-heading" className="w-full min-w-0 max-w-3xl">
    <h2 id="corpus-dashboard-heading" className="mb-2 px-1 text-xs font-bold tracking-wider text-muted-foreground uppercase">Collections in this browser</h2>
    <ul ref={e => { target.current = e; }} className="corpus-cards grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{(['nfcorpus', 'msmarco'] as const).map(corpus => <CollectionCard key={corpus} corpus={corpus} selected={selected === corpus} choose={() => { runtime.chat.select(corpus); document.getElementById('chat-query')?.focus(); }} />)}</ul>
  </section>;
}
function CollectionCard({ corpus, selected, choose }: { corpus: Corpus; selected: boolean; choose(): void }) {
  const state = useResources(s => s.resources[corpus]);
  const status = cardStatus(corpus, state.phase, state.message), info = collectionInfo[corpus];
  return <li className="min-w-0"><Card className={cn('h-full min-w-0 p-4 transition-shadow', selected && 'border-primary/35 ring-1 ring-primary/10')} data-corpus={corpus} data-status={status.light}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3><button type="button" className="inline-flex items-center gap-2 rounded text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring" onClick={choose} data-collection-select={corpus} aria-pressed={selected}><span aria-hidden="true" className={cn('size-2.5 rounded-full', status.light === 'available' ? 'bg-emerald-600 shadow-[0_0_0_3px_#e0f0e5]' : status.light === 'pending' ? 'bg-amber-500' : 'bg-muted-foreground/40')} />{info.name}</button></h3><span className="text-xs font-semibold text-primary">{status.label}</span></div>
    <p className="text-sm leading-relaxed text-muted-foreground">{info.description}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{status.detail ?? info.detail}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2"><CollectionActions corpus={corpus} />{selected && <Badge>Selected</Badge>}</div>
  </Card></li>;
}
export function CollectionReadiness() {
  const selected = useConversations(s => s.selected);
  const state = useResources(s => s.resources[selected]);
  const busy = useResources(s => s.busy);
  const activeSearch = useResources(s => s.activeSearch);
  if ((state.phase === 'ready' && !busy) || activeSearch === selected) return null;
  return <Alert id={selected === 'nfcorpus' ? 'fts-help' : 'marco-help'} className="space-y-2 text-xs" aria-live={selected === 'msmarco' ? 'off' : 'polite'}>
    <p>{busy && state.phase === 'ready' ? 'Search is temporarily paused while another database operation finishes.' : state.message} <NavLink href={`?view=setup#setup-${selected}`} className="font-semibold underline underline-offset-4">Settings</NavLink></p>
    <CollectionActions corpus={selected} />
  </Alert>;
}
