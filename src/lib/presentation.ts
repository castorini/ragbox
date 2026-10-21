import type { ResourcePhase, ResourceState } from '../resource-state.ts';
import type { Conversation, Corpus } from '../types.ts';

type Light = 'available' | 'unavailable' | 'pending';

interface CardStatus {
  light: Light;
  label: string;
  detail?: string;
  setup?: string;
}

const corpora = {
  nfcorpus: { name: 'NFCorpus', missing: 'Not prepared', setup: 'Prepare NFCorpus' },
  msmarco: { name: 'MS MARCO', missing: 'Not downloaded', setup: 'Download MS MARCO index (3.35 GB)' },
} as const;

export function cardStatus(corpus: Corpus, phase: ResourcePhase, message: string): CardStatus {
  const info = corpora[corpus];
  switch (phase) {
    case 'ready': return { light: 'available', label: 'Ready to search' };
    case 'saved': return { light: 'available', label: 'Downloaded', detail: 'Opens automatically when you select it.' };
    case 'missing': return { light: 'unavailable', label: info.missing, setup: info.setup };
    case 'checking': return { light: 'pending', label: 'Checking…' };
    case 'opening': return { light: 'pending', label: 'Opening…', detail: message };
    case 'preparing': return { light: 'pending', label: 'Preparing…', detail: message };
    case 'downloading': return { light: 'pending', label: 'Downloading…', detail: message };
    case 'unsupported': return { light: 'unavailable', label: 'Not supported', detail: 'Use desktop Chrome on localhost or HTTPS.' };
    default: return { light: 'unavailable', label: 'Needs attention', detail: message, setup: 'Fix in Settings' };
  }
}

export function settingsCollectionStatus(corpus: Corpus, state: ResourceState) {
  switch (state.phase) {
    case 'ready': return { label: 'Ready to search', detail: '' };
    case 'saved': return { label: 'Downloaded', detail: 'Opens when selected.' };
    case 'missing': return {
      label: corpus === 'nfcorpus' ? 'Not set up' : 'Not downloaded',
      detail: corpus === 'nfcorpus' ? 'Set up this small collection once in this browser.' : 'One-time download saved in this browser.',
    };
    case 'checking': return { label: 'Checking…', detail: '' };
    case 'opening': return { label: 'Opening…', detail: state.message };
    case 'preparing': return { label: 'Setting up…', detail: state.message };
    case 'downloading': return { label: 'Downloading…', detail: state.message };
    case 'unsupported': return { label: 'Unavailable', detail: 'Search needs a supported browser on HTTPS or localhost.' };
    default: return { label: 'Needs attention', detail: state.message };
  }
}


export function sourceAnchor(conversationId: string, turnId: string, documentId: string) {
  return `chat-source-${encodeURIComponent(conversationId)}-${encodeURIComponent(turnId)}-${encodeURIComponent(documentId)}`;
}

export function matchesConversation(conversation: Conversation, filter: string) {
  const text = [conversation.title, conversation.corpus === 'msmarco' ? 'MS MARCO' : 'NFCorpus', ...conversation.turns.flatMap(turn => [turn.question, turn.answer, ...turn.results.map(result => result.title)])].join(' ').toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}


export function handleComposerKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'preventDefault'>, send: () => void) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
}

