import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { HISTORY_ENABLED } from '../features.ts';
export type View = 'search' | 'setup' | 'duckdb' | 'history';
export const setupSections = ['model', 'model-storage', 'model-management', 'setup-nfcorpus', 'setup-msmarco', 'collection-management', 'storage-management'];
export function readRoute(historyEnabled = HISTORY_ENABLED) {
  const url = new URL(location.href);
  const value = url.searchParams.get('view');
  const view: View = value === 'setup' || value === 'duckdb' || (value === 'history' && historyEnabled) ? value : 'search';
  return { view, hash: url.hash, focus: false, revision: 0 };
}
function createNavigation(historyEnabled: boolean) {
  const state = createStore(() => readRoute(historyEnabled));
  const sync = () => state.setState({ ...readRoute(historyEnabled), revision: state.getState().revision + 1 });
  return { state,
    listen() { window.addEventListener('popstate', sync); window.addEventListener('hashchange', sync); return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); }; },
    go(view: View, hash = '') {
      const url = new URL(location.href);
      if (view === 'search') url.searchParams.delete('view'); else url.searchParams.set('view', view);
      url.hash = hash;
      if (url.href !== location.href) history.pushState(null, '', url);
      state.setState({ ...readRoute(historyEnabled), focus: true, revision: state.getState().revision + 1 });
      if (!hash) window.scrollTo({ top: 0 });
    },
  };
}
const NavigationContext = createContext<ReturnType<typeof createNavigation> | null>(null);
export function NavigationProvider({ children, historyEnabled = HISTORY_ENABLED }: { children: ReactNode; historyEnabled?: boolean }) {
  const [navigation] = useState(() => createNavigation(historyEnabled));
  useEffect(() => navigation.listen(), [navigation]);
  return <NavigationContext value={navigation}>{children}</NavigationContext>;
}
export function useNavigation() { const navigation = useContext(NavigationContext); if (!navigation) throw new Error('NavigationProvider is missing.'); return navigation; }
export function useRoute() { return useStore(useNavigation().state); }
export function NavLink({ href = '?', onClick, ...props }: ComponentProps<'a'>) {
  const navigation = useNavigation();
  return <a href={href} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === '_blank') return;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !href.startsWith('?')) return;
    event.preventDefault();
    const value = url.searchParams.get('view');
    navigation.go(value === 'setup' || value === 'duckdb' || value === 'history' ? value : 'search', url.hash);
  }} {...props} />;
}
