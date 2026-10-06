export type Corpus = 'nfcorpus' | 'msmarco';
export type ThinkingEffort = 'low' | 'balanced' | 'high';

export interface EvidenceDocument {
  id: string;
  title: string;
  text: string;
}

export interface SearchResult extends EvidenceDocument { score: number }
export interface RetrievalResult { documents: SearchResult[]; elapsedMs: number }
export interface ChatOperation { conversationId: string; turnId: string; attemptId: string }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type TurnPhase = 'resolving' | 'retrieving' | 'waiting' | 'generating' | 'complete' | 'stopped' | 'error' | 'blocked';
export type TurnStage = 'resolve' | 'retrieve' | 'generate';
export interface ChatTurn {
  id: string;
  question: string;
  searchQuery?: string;
  results: SearchResult[];
  answer: string;
  thinking?: string;
  thinkingEffort?: ThinkingEffort;
  includedIds: string[];
  citedIds: string[];
  phase: TurnPhase;
  stage: TurnStage;
  message: string;
  keywordOnly?: boolean;
  contextLimited?: boolean;
  elapsedMs?: number;
  history: ChatMessage[];
}
export interface Conversation {
  id: string;
  corpus: Corpus;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

export interface ModelProgress {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
  downloadedBytes?: number;
  stage?: 'downloading' | 'initializing';
}

export type ModelCacheAvailability = 'checking' | 'missing' | 'incomplete' | 'installed' | 'corrupt' | 'unknown';
export type ModelFailureReason = 'missing' | 'incomplete' | 'corrupt' | 'cache' | 'network' | 'storage' | 'initialization' | 'generation';
export interface ModelStatus {
  cache: ModelCacheAvailability;
  stage: 'checking' | 'queued' | 'downloading' | 'initializing' | 'idle' | 'ready';
  downloadedBytes: number;
  failure?: ModelFailureReason;
}

export type WorkerRequest =
  | { type: 'load'; cachedOnly?: boolean; loadId?: number }
  | { type: 'generate'; requestId: string; corpus: Corpus; question: string; documents: EvidenceDocument[]; history?: ChatMessage[]; searchQuery?: string; thinkingEffort?: ThinkingEffort; operation?: ChatOperation }
  | { type: 'resolve-query'; requestId: string; question: string; history: ChatMessage[]; operation?: ChatOperation }
  | { type: 'cancel'; requestId: string };

export type WorkerResponse =
  | { type: 'cache-unavailable'; operation: 'load'; message: string; loadId?: number; reason?: ModelFailureReason }
  | { type: 'cache-status'; loadId: number; availability: ModelCacheAvailability }
  | { type: 'progress'; progress: ModelProgress; loadId?: number }
  | { type: 'ready'; model: string; revision: string; loadId?: number }
  | { type: 'context'; requestId: string; documentIds: string[]; contextLimited?: boolean }
  | { type: 'resolved-query'; requestId: string; query: string; contextLimited: boolean }
  | { type: 'answer-delta'; requestId: string; text: string }
  | { type: 'answer-reset'; requestId: string }
  | { type: 'thinking-delta'; requestId: string; text: string }
  | { type: 'complete'; requestId: string; answer: string; thinking?: string; documentIds: string[] }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; operation: 'load' | 'generate' | 'resolve-query'; requestId?: string; loadId?: number; reason?: ModelFailureReason; message: string };

export type RunTask = <T>(task: () => Promise<T>, searchCorpus?: Corpus) => Promise<T | undefined>;
