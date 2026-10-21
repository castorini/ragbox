import { useEffect, useLayoutEffect } from 'react';
import { useStore } from 'zustand';
import { BookOpen, History, MessageSquareText, SlidersHorizontal } from 'lucide-react';
import { HISTORY_ENABLED } from '../features.ts';
import { cn } from '../lib/utils.ts';
import { Alert } from '../components/ui/card.tsx';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { useRuntime, useConversations, useResources } from './context.tsx';
import { NavigationProvider, NavLink, setupSections, useRoute } from './navigation.tsx';
import { ConfirmationProvider } from './confirmation.tsx';
import { TourProvider, useTourTarget } from './tour.tsx';
import { ChatPage } from './chat.tsx';
import { SettingsPage } from './settings.tsx';
import { GuidePage } from './guide.tsx';
import { HistoryPage } from './history.tsx';
export function App({ historyEnabled = HISTORY_ENABLED }: { historyEnabled?: boolean }) {
  return <NavigationProvider historyEnabled={historyEnabled}><TooltipProvider delayDuration={350}><ConfirmationProvider><TourProvider historyEnabled={historyEnabled}><Shell historyEnabled={historyEnabled} /></TourProvider></ConfirmationProvider></TooltipProvider></NavigationProvider>;
}
function Shell({ historyEnabled }: { historyEnabled: boolean }) {
  const runtime = useRuntime();
  const route = useRoute();
  const status = useStore(runtime.status);
  const model = useResources(s => `${s.resources.model.phase}:${s.resources.model.model?.stage}:${s.resources.model.model?.failure}:${s.resources.model.model?.cache}`);
  const modelMessage = runtime.resources.get('model').message;
  const marco = useResources(s => s.resources.msmarco.phase);
  const labels = { search: 'Chat', setup: 'Settings', duckdb: 'How it works', history: 'History' };
  const sectionHash = route.view === 'setup' && setupSections.includes(route.hash.slice(1)) ? route.hash === '#storage-management' ? '#collection-management' : route.hash : undefined;
  const target = sectionHash ?? (route.view === 'setup' ? '#setup-heading' : route.view === 'duckdb' ? '#duckdb-intro-heading' : route.view === 'history' ? '#history-heading' : '#chat-query');
  useEffect(() => { document.title = `${labels[route.view]} · ragbox`; }, [route.view]);
  useLayoutEffect(() => {
    if (!route.focus && !sectionHash) return;
    const element = document.getElementById(target.slice(1));
    if (!element) return;
    let ancestor: HTMLElement | null = element;
    while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
    element.scrollIntoView({ block: 'start' });
    const action = sectionHash === '#model' ? document.getElementById('llm-load') : null;
    if (action && !action.hidden && !action.matches(':disabled')) action.focus({ preventScroll: true }); else element.focus({ preventScroll: true });
  }, [route.revision, target, sectionHash]);
  return <>
    <a className="skip-link" href={target}>Skip to {labels[route.view].toLowerCase()}</a>
    <Sidebar historyEnabled={historyEnabled} />
    <main className="app-main" data-startup={status.phase}>
      {status.message && status.phase !== 'opening' && <Alert id="status" className="mt-4 border-destructive/30 bg-[#fff5f2] text-destructive">{status.message}</Alert>}
      <ModelAnnouncement stateKey={model} message={runtime.resources.get('model').model?.stage === 'downloading' ? 'Downloading model…' : modelMessage} />
      <p className="sr-only" role="status">{marco === 'downloading' ? 'Downloading MS MARCO index…' : marco === 'ready' ? 'MS MARCO is ready to search.' : ''}</p>
      <ChatPage /><SettingsPage /><GuidePage />{historyEnabled && <HistoryPage />}
    </main>
  </>;
}
function ModelAnnouncement({ stateKey, message }: { stateKey: string; message: string }) {
  // Byte-only progress updates do not change this key or repeat announcements.
  return <p key={stateKey} className="sr-only" role="status">{message}</p>;
}
function Sidebar({ historyEnabled }: { historyEnabled: boolean }) {
  const route = useRoute();
  const historyTarget = useTourTarget('history'), settingsTarget = useTourTarget('settings'), guideTarget = useTourTarget('guide');
  const links = [
    { view: 'search', name: 'Chat', Icon: MessageSquareText, href: '?', target: undefined },
    ...(historyEnabled ? [{ view: 'history', name: 'History', Icon: History, href: '?view=history', target: historyTarget }] : []),
    { view: 'setup', name: 'Settings', Icon: SlidersHorizontal, href: '?view=setup', target: settingsTarget },
    { view: 'duckdb', name: 'How it works', Icon: BookOpen, href: '?view=duckdb', target: guideTarget },
  ];
  return <nav className="side-rail" aria-label="Main navigation">{links.map(({ view, name, Icon, href, target }) => <NavLink key={view} ref={e => { if (target) target.current = e; }} id={`nav-${view}`} href={href} title={name} aria-label={name} aria-current={route.view === view ? 'page' : undefined} className={cn('rail-link', route.view === view && 'is-current')}><Icon aria-hidden="true" /><span>{name}</span></NavLink>)}</nav>;
}
