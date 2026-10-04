export type Corpus = 'nfcorpus' | 'msmarco';

export interface EvidenceDocument {
  id: string;
  title: string;
  text: string;
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
  | { type: 'generate'; requestId: string; corpus: Corpus; question: string; documents: EvidenceDocument[] }
  | { type: 'cancel'; requestId: string };

export type WorkerResponse =
  | { type: 'cache-unavailable'; operation: 'load'; message: string; loadId?: number; reason?: ModelFailureReason }
  | { type: 'cache-status'; loadId: number; availability: ModelCacheAvailability }
  | { type: 'progress'; progress: ModelProgress; loadId?: number }
  | { type: 'ready'; model: string; revision: string; loadId?: number }
  | { type: 'context'; requestId: string; documentIds: string[] }
  | { type: 'answer-delta'; requestId: string; text: string }
  | { type: 'complete'; requestId: string; answer: string; documentIds: string[] }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; operation: 'load' | 'generate'; requestId?: string; loadId?: number; reason?: ModelFailureReason; message: string };

export type RunTask = <T>(task: () => Promise<T>, searchCorpus?: Corpus) => Promise<T | undefined>;
