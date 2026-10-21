import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { AppRuntime } from '../runtime.ts';
import type { ConversationSnapshot } from '../conversations.ts';
import type { ResourceSnapshot } from '../resource-state.ts';
const RuntimeContext = createContext<AppRuntime | null>(null);
export function RuntimeProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) { return <RuntimeContext value={runtime}>{children}</RuntimeContext>; }
export function useRuntime() { const runtime = useContext(RuntimeContext); if (!runtime) throw new Error('RuntimeProvider is missing.'); return runtime; }
export function useConversations<T>(selector: (s: ConversationSnapshot) => T) { return useStore(useRuntime().conversations.state, selector); }
export function useResources<T>(selector: (s: ResourceSnapshot) => T) { return useStore(useRuntime().resources.state, selector); }
