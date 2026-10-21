import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Check, Copy, Lightbulb, LoaderCircle, SquarePen, Square } from 'lucide-react';
import { currentConversation, currentDraft } from '../conversations.ts';
import { MAX_QUESTION_LENGTH } from '../chat-controller.ts';
import { EXAMPLE_QUERIES } from '../example-queries.ts';
import type { ChatTurn } from '../types.ts';
import { sourceAnchor, handleComposerKey } from '../lib/presentation.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../components/ui/button.tsx';
import { Textarea } from '../components/ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { useConversations, useResources, useRuntime } from './context.tsx';
import { NavLink, useNavigation, useRoute } from './navigation.tsx';
import { CollectionCards, CollectionReadiness } from './collections.tsx';
import { ModelControls } from './model-controls.tsx';
import { useTour, useTourTarget } from './tour.tsx';
export function ChatPage() {
  const runtime = useRuntime(), route = useRoute(), nav = useNavigation(), tour = useTour();
  const hasTurns = useConversations(s => currentConversation(s).turns.length > 0);
  const unsaved = useConversations(s => s.unsaved);
  const [composerHeight, setComposerHeight] = useState(160);
  return <section id="search-view" hidden={route.view !== 'search'} aria-labelledby="search-heading" className={cn('chat-page', hasTurns && 'has-turns')} style={{ '--composer-space': `${composerHeight + 24}px` } as CSSProperties}>
    <div className={cn('search-brand', hasTurns && 'flex items-center justify-between')}>
      <div><h1 id="search-heading" tabIndex={-1}><NavLink id="home-link" href="?" className="search-logo" onClick={e => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); runtime.chat.newChat(); nav.go('search'); } }}>RAGbox</NavLink></h1>{!hasTurns && <p className="mt-1 text-base text-muted-foreground">RAG in a browser</p>}</div>
      {hasTurns && <Button id="chat-new" variant="outline" size="sm" onClick={() => { runtime.chat.newChat(); document.getElementById('chat-query')?.focus(); }}><SquarePen aria-hidden="true" />New chat</Button>}
    </div>
    <h2 id="chat-title" className="sr-only">{hasTurns ? runtime.conversations.current().title : 'Ask your documents'}</h2>
    {unsaved && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{unsaved}</p>}
    <Transcript />
    <Composer active={hasTurns} onResize={setComposerHeight} />
    {!hasTurns && <><CollectionCards /><Button variant="link" size="sm" onClick={tour.start}>Take a quick tour</Button></>}
  </section>;
}
function Transcript() {
  const conversation = useConversations(currentConversation);
  const route = useRoute();
  const seen = useRef({ conversation: conversation.id, latest: conversation.turns.at(-1)?.id });
  const rows = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const latest = conversation.turns.at(-1);
    const asked = seen.current.conversation === conversation.id && latest && latest.id !== seen.current.latest;
    seen.current = { conversation: conversation.id, latest: latest?.id };
    if (!asked || route.view !== 'search') return;
    const frame = requestAnimationFrame(() => {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (conversation.turns.length === 1) window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
      else rows.current.get(latest.id)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation.id, conversation.turns.length, route.view]);
  return <div id="chat-transcript" role="log" aria-label="Conversation" aria-live="off" className="chat-transcript">{conversation.turns.map((turn, i) => <Turn key={`${conversation.id}:${turn.id}`} turn={turn} conversationId={conversation.id} latest={i === conversation.turns.length - 1} register={element => { if (element) rows.current.set(turn.id, element); else rows.current.delete(turn.id); }} />)}</div>;
}
function CitationText({ text, targets, openSource }: { text: string; targets: Map<string, string>; openSource(target: string): void }) {
  const nodes: ReactNode[] = []; let position = 0;
  for (const match of text.matchAll(/\[([^\]\n]+)\]/g)) {
    nodes.push(text.slice(position, match.index));
    const target = targets.get(match[1]);
    nodes.push(target ? <a key={match.index} href={`#${target}`} title={`Jump to retrieved evidence ${match[1]}`} className="font-semibold text-primary underline decoration-primary/40 underline-offset-4" onClick={e => { e.preventDefault(); openSource(target); }}>{match[0]}</a> : match[0]);
    position = match.index + match[0].length;
  }
  nodes.push(text.slice(position)); return <>{nodes}</>;
}
const Turn = memo(function Turn({ turn, conversationId, latest, register }: { turn: ChatTurn; conversationId: string; latest: boolean; register(element: HTMLElement | null): void }) {
  const runtime = useRuntime();
  const blocked = useResources(s => s.busy || s.shuttingDown || s.resources[runtime.conversations.selected].phase !== 'ready');
  const unsupported = useResources(s => s.resources.model.phase === 'unsupported');
  const running = useConversations(s => !!s.activeOperation || currentConversation(s).turns.at(-1)?.phase === 'waiting');
  const sources = useRef<HTMLDetailsElement>(null);
  const [feedback, setFeedback] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyNumber = useRef(0);
  useEffect(() => { ++copyNumber.current; setFeedback(''); return () => { ++copyNumber.current; clearTimeout(timer.current); }; }, [turn.answer]);
  const included = new Set(turn.includedIds);
  const targets = new Map(turn.results.filter(document => included.has(document.id)).map(document => [document.id, sourceAnchor(conversationId, turn.id, document.id)]));
  const reasoning = !!turn.thinking || (turn.phase === 'generating' && turn.thinkingEffort !== 'off');
  const thinkingLabel = turn.phase === 'generating' && !turn.answer ? 'Thinking…' : turn.phase === 'stopped' ? 'Reasoning (stopped)' : 'Reasoning';
  const activity = turn.phase === 'resolving' ? 'resolving' : turn.phase === 'retrieving' ? 'searching' : turn.phase !== 'generating' ? '' : turn.answer ? 'writing' : turn.thinkingEffort === 'off' ? 'preparing' : 'thinking';
  const openSource = (target: string) => {
    if (sources.current) sources.current.open = true;
    const element = document.getElementById(target); element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest' });
  };
  return <article ref={register} className="chat-turn" data-phase={turn.phase} data-activity={activity}>
    <div className="chat-user"><span className="chat-speaker">You</span><h3 className="whitespace-pre-wrap text-xl leading-relaxed font-semibold break-words">{turn.question}</h3></div>
    <div className="chat-assistant"><span className="chat-speaker inline-flex items-center gap-2">RAGbox{['resolving', 'searching', 'thinking', 'preparing'].includes(activity) && <Fragment>{activity === 'preparing' ? <Lightbulb className="size-4 text-primary motion-safe:animate-pulse" aria-hidden="true" /> : <LoaderCircle className="size-3.5 text-primary motion-safe:animate-spin" aria-hidden="true" />}</Fragment>}</span>
      <details hidden={!reasoning} className="mb-3 text-sm text-muted-foreground"><summary>{thinkingLabel}</summary><p className="mt-2 whitespace-pre-wrap">{turn.thinking}</p></details>
      <div className="chat-answer-block"><p hidden={!turn.answer} className="llm-answer whitespace-pre-wrap leading-7 break-words"><CitationText text={turn.answer} targets={targets} openSource={openSource} /></p>
        {!!turn.answer.trim() && <div className="mt-1 flex items-center gap-2"><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={feedback === 'Copied' ? 'Answer copied' : 'Copy answer'} onClick={async () => {
          const attempt = ++copyNumber.current;
          try { if (!navigator.clipboard) throw new Error('Unavailable'); await navigator.clipboard.writeText(turn.answer); if (attempt === copyNumber.current) setFeedback('Copied'); }
          catch { if (attempt === copyNumber.current) setFeedback('Could not copy. Select the answer text to copy.'); }
          clearTimeout(timer.current); timer.current = setTimeout(() => { if (attempt === copyNumber.current) setFeedback(''); }, 2000);
        }}>{feedback === 'Copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button></TooltipTrigger><TooltipContent>Copy answer</TooltipContent></Tooltip><span role="status" className="text-xs text-muted-foreground">{feedback}</span></div>}
      </div>
      <p role="status" hidden={(turn.phase === 'complete' && !turn.keywordOnly) || (reasoning && turn.message === thinkingLabel)} className="mt-2 text-sm text-muted-foreground">{turn.message}</p>
      {turn.contextLimited && <p className="mt-2 text-xs text-muted-foreground">Using up to the latest 3 turns, within the model’s context limit. Earlier messages remain saved.</p>}
      <details ref={sources} hidden={!turn.results.length} className="chat-sources"><summary className="py-2 text-sm font-semibold text-primary">Sources ({turn.results.length})</summary><p className="mb-3 text-xs text-muted-foreground">{turn.keywordOnly ? 'Keyword search' : 'Search'}: {turn.searchQuery ?? turn.question}{turn.elapsedMs == null ? '' : ` · ${turn.elapsedMs.toFixed(0)} ms`}</p>
        <ol className="space-y-5">{turn.results.map(result => <li key={result.id} id={sourceAnchor(conversationId, turn.id, result.id)} tabIndex={-1} className="rounded-lg border-t pt-4 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"><h4 className="font-semibold">{result.title}</h4><p className="mt-1 text-xs text-muted-foreground">{result.id} · BM25 {result.score.toFixed(4)}</p><p className="mt-2 text-sm leading-relaxed">{result.text.slice(0, 350)}{result.text.length > 350 && '…'}</p><details className="mt-2 text-sm text-muted-foreground"><summary>Full document text</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{result.text}</p></details></li>)}</ol>
      </details>
      {latest && ['error', 'stopped', 'blocked'].includes(turn.phase) && <Button variant="outline" size="sm" className="mt-3" disabled={running || blocked || (unsupported && turn.stage === 'generate' && !turn.keywordOnly)} onClick={() => { void runtime.chat.retry(); }}>{turn.phase === 'blocked' ? 'Retry answer' : 'Retry'}</Button>}
    </div>
  </article>;
}, (before, after) => before.turn === after.turn && before.latest === after.latest && before.conversationId === after.conversationId);
function Composer({ active, onResize }: { active: boolean; onResize(height: number): void }) {
  const runtime = useRuntime();
  const draft = useConversations(currentDraft), corpus = useConversations(s => s.selected);
  const initialized = useConversations(s => s.initialized);
  const running = useConversations(s => !!s.activeOperation || currentConversation(s).turns.at(-1)?.phase === 'waiting');
  const available = useResources(s => !s.busy && !s.shuttingDown && s.resources[corpus].phase === 'ready');
  const input = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null);
  const target = useTourTarget('composer');
  const [suggestions, setSuggestions] = useState(false), [index, setIndex] = useState(-1);
  const examples = EXAMPLE_QUERIES[corpus];
  const shown = active && suggestions && !draft.trim();
  const tooLong = draft.trim().length > MAX_QUESTION_LENGTH;
  const canSend = initialized && available && !running && !tooLong && !!draft.trim();
  useLayoutEffect(() => { const element = input.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight || 44, 150)}px`; } onResize(form.current?.offsetHeight ?? 160); }, [draft, onResize]);
  useLayoutEffect(() => { const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => onResize(form.current?.offsetHeight ?? 160)); if (form.current) observer?.observe(form.current); return () => observer?.disconnect(); }, [onResize]);
  useEffect(() => { setIndex(-1); setSuggestions(false); }, [corpus]);
  const submit = (question = draft) => {
    if (!runtime.chat.canSend() || !question.trim() || question.trim().length > MAX_QUESTION_LENGTH) return;
    runtime.conversations.setDraft(''); setSuggestions(false); setIndex(-1); void runtime.chat.send(question);
  };
  const choose = (question: string) => { setSuggestions(false); setIndex(-1); if (runtime.chat.canSend()) submit(question); else runtime.conversations.setDraft(question); input.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const open = shown || (event.key === 'ArrowDown' && active && !draft.trim());
    if (open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setSuggestions(true); const step = event.key === 'ArrowDown' ? 1 : -1; setIndex(i => i < 0 ? (step > 0 ? 0 : examples.length - 1) : (i + step + examples.length) % examples.length); }
    else if (shown && event.key === 'Escape') { event.preventDefault(); setSuggestions(false); setIndex(-1); }
    else handleComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, preventDefault: () => event.preventDefault() }, () => { if (shown && index >= 0) choose(examples[index]); else submit(); });
  };
  return <form ref={form} id="chat-form" aria-label="Ask your documents" className={cn('chat-composer', active && 'is-pinned')} onSubmit={e => { e.preventDefault(); if (running) runtime.chat.stop(); else submit(); }}>
    <ModelControls /><CollectionReadiness />
    <div className="relative">
      {shown && <ul id="chat-suggestions" role="listbox" aria-label="Example questions" className="absolute right-0 bottom-full left-0 z-20 mb-2 rounded-xl border bg-card p-1 shadow-lg">{examples.map((question, i) => <li key={question} id={`chat-suggestion-${i}`} role="option" aria-selected={i === index} className={cn('cursor-pointer rounded-lg px-3 py-3 text-sm hover:bg-secondary', i === index && 'bg-secondary')} onMouseDown={e => e.preventDefault()} onClick={() => choose(question)}>{question}</li>)}</ul>}
      <div className="chat-input-row flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15" ref={e => { target.current = e; }}>
        <Textarea ref={input} id="chat-query" rows={1} required aria-label="Ask your documents" placeholder="Ask your documents…" role="combobox" aria-autocomplete="list" aria-controls={shown ? 'chat-suggestions' : undefined} aria-expanded={shown} aria-activedescendant={shown && index >= 0 ? `chat-suggestion-${index}` : undefined} aria-invalid={tooLong || undefined} aria-describedby={`${corpus === 'nfcorpus' ? 'fts-help' : 'marco-help'}${tooLong ? ' chat-length-warning' : ''}`} value={draft} onChange={e => { runtime.conversations.setDraft(e.target.value); setSuggestions(true); setIndex(-1); }} onKeyDown={onKeyDown} onFocus={() => setSuggestions(true)} onClick={() => setSuggestions(true)} onBlur={() => { setSuggestions(false); setIndex(-1); }} className="max-h-37.5 min-h-11 resize-none border-0 bg-transparent py-2.5 text-base shadow-none focus-visible:ring-0" />
        <Select value={corpus} onValueChange={value => { runtime.chat.select(value === 'msmarco' ? 'msmarco' : 'nfcorpus'); input.current?.focus(); }}><SelectTrigger id="collection-switch" aria-label="Document collection" className="mb-0.5 shrink-0 border-0 border-l bg-secondary/50 text-xs"><SelectValue /></SelectTrigger><SelectContent onCloseAutoFocus={e => { e.preventDefault(); input.current?.focus(); }}><SelectItem value="nfcorpus">NFCorpus</SelectItem><SelectItem value="msmarco">MS MARCO</SelectItem></SelectContent></Select>
        <Button id="chat-send" type={running ? 'button' : 'submit'} onClick={running ? () => runtime.chat.stop() : undefined} size="icon" className="mb-0.5 rounded-full" aria-label={running ? 'Stop current reply' : 'Send message'} title={running ? 'Stop' : 'Send'} disabled={running ? false : !canSend} data-mode={running ? 'stop' : 'send'}>{running ? <Square className="fill-current" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</Button>
      </div>
    </div>
    {tooLong && <p id="chat-length-warning" role="alert" className="text-sm text-destructive">Your question is {draft.trim().length} characters. Shorten it to {MAX_QUESTION_LENGTH} or fewer to send.</p>}
    {!active && <div id="chat-examples" className="flex flex-wrap justify-center gap-2">{examples.map(question => <Button key={question} variant="ghost" size="sm" className="h-auto max-w-full text-xs whitespace-normal" onClick={() => choose(question)}>{question}</Button>)}</div>}
  </form>;
}
