import type { Corpus } from './types.ts';

// Pools of starter questions. Each was checked against its collection's BM25 index:
// the top results must state the answer itself, not just discuss the topic. Only the
// first few NFCorpus abstracts fit the model's 3,500-token input, so an answer that
// appears only lower in the ranking is not good enough. Check new ones the same way.
export const EXAMPLE_POOL: Record<Corpus, readonly string[]> = {
  nfcorpus: [
    'Does soy increase breast cancer risk?',
    'Does curcumin have anti-inflammatory effects?',
    'Does dairy cause acne?',
    'Does green tea help prevent cancer?',
    'Can a vegan diet help manage type 2 diabetes?',
    'Do nuts lower cholesterol?',
    'Does red meat increase colorectal cancer risk?',
  ],
  msmarco: [
    'who invented the telephone',
    'how does the greenhouse effect warm the earth',
    'how do solar panels generate electricity',
    'how does caffeine affect the body',
    'how does insulin regulate blood sugar',
    'what are the side effects of antibiotics',
  ],
};
export const EXAMPLE_COUNT = 3;

// Distinct random picks in random order (partial Fisher–Yates shuffle).
export function pickExamples(pool: readonly string[], count = EXAMPLE_COUNT, random = Math.random): string[] {
  const items = [...pool];
  const picks = Math.min(count, items.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(random() * (items.length - i));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.slice(0, picks);
}

// Chosen once per page load, so the start page and the search dropdown agree.
export const EXAMPLE_QUERIES: Record<Corpus, readonly string[]> = {
  nfcorpus: pickExamples(EXAMPLE_POOL.nfcorpus),
  msmarco: pickExamples(EXAMPLE_POOL.msmarco),
};
