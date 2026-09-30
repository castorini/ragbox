export type Corpus = 'nfcorpus' | 'msmarco';

export interface EvidenceDocument {
  id: string;
  title: string;
  text: string;
}

export interface ModelProgress {
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
}

export type WorkerRequest =
  | { type: 'load'; cachedOnly?: boolean }
  | { type: 'generate'; requestId: string; corpus: Corpus; question: string; documents: EvidenceDocument[] }
  | { type: 'cancel'; requestId: string };

export type WorkerResponse =
  | { type: 'cache-unavailable'; operation: 'load'; message: string }
  | { type: 'progress'; progress: ModelProgress }
  | { type: 'ready'; model: string; revision: string }
  | { type: 'context'; requestId: string; documentIds: string[] }
  | { type: 'answer-delta'; requestId: string; text: string }
  | { type: 'complete'; requestId: string; answer: string; documentIds: string[] }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; operation: 'load' | 'generate'; requestId?: string; message: string };

export type RunTask = <T>(task: () => Promise<T>, searchCorpus?: Corpus) => Promise<T | undefined>;
