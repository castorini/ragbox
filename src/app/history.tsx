import { memo, useMemo, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Card } from '../components/ui/card.tsx';
import { matchesConversation } from '../lib/presentation.ts';
import type { Conversation } from '../types.ts';
import { useRuntime, useConversations } from './context.tsx';
import { useRoute, useNavigation, NavLink } from './navigation.tsx';
import { useConfirm } from './confirmation.tsx';
export function HistoryPage() {
  const runtime = useRuntime(), route = useRoute(), confirm = useConfirm();
  const items = useConversations(s => s.items);
  const [filter, setFilter] = useState('');
  const all = useMemo(() => Object.values(items).filter(c => c.turns.length).sort((a, b) => b.updatedAt - a.updatedAt), [items]);
  const matches = all.filter(c => matchesConversation(c, filter));
  return <section id="history-view" hidden={route.view !== 'history'} aria-labelledby="history-heading" className="space-y-5 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 id="history-heading" tabIndex={-1} className="page-heading">History</h1><Button variant="destructive" size="sm" disabled={!all.length} onClick={() => confirm({ title: 'Clear history?', description: 'All saved conversations and their source snapshots will be removed from this browser. Collections and the answer model are kept.', label: 'Clear history', destructive: true, action: () => runtime.chat.clear() })}>Clear history</Button></header>
    {!all.length ? <p className="text-sm text-muted-foreground">No saved conversations yet. <NavLink href="?" className="font-semibold underline">Start a chat</NavLink>.</p> : <><div className="flex flex-wrap items-center gap-3"><Input aria-label="Search conversations" placeholder="Search conversations" value={filter} maxLength={200} onChange={e => setFilter(e.target.value)} className="max-w-md" /><span role="status" className="text-sm text-muted-foreground">{matches.length} conversation{matches.length === 1 ? '' : 's'}</span></div>{!matches.length && <p className="text-sm text-muted-foreground">No conversations match your search.</p>}<ol className="space-y-3">{matches.map(conversation => <HistoryCard key={conversation.id} conversation={conversation} />)}</ol></>}
  </section>;
}
const HistoryCard = memo(function HistoryCard({ conversation }: { conversation: Conversation }) {
  const runtime = useRuntime(), navigation = useNavigation();
  return <li><Card className="space-y-3 p-5"><div><h2 className="font-semibold">{conversation.title}</h2><p className="mt-1 text-xs text-muted-foreground">{conversation.corpus === 'nfcorpus' ? 'NFCorpus' : 'MS MARCO'} · {new Date(conversation.updatedAt).toLocaleString()} · {conversation.turns.length} turn{conversation.turns.length === 1 ? '' : 's'}</p></div><details className="text-sm"><summary className="text-primary">View conversation</summary><div className="mt-3 space-y-4">{conversation.turns.map(turn => <div key={turn.id}><p className="font-semibold">You: {turn.question}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">RAGbox: {turn.answer || turn.message}{turn.phase === 'stopped' && ' (Stopped)'}</p></div>)}</div></details><Button size="sm" variant="outline" onClick={() => { runtime.chat.open(conversation.id); navigation.go('search'); }}>Continue chat</Button></Card></li>;
});
