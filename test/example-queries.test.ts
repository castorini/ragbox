import { it, expect } from 'vitest';
import { EXAMPLE_COUNT, EXAMPLE_POOL, EXAMPLE_QUERIES, pickExamples } from '../src/example-queries.ts';

it('shows three distinct questions drawn from each collection pool', () => {
  for (const corpus of ['nfcorpus', 'msmarco'] as const) {
    expect(EXAMPLE_QUERIES[corpus]).toHaveLength(EXAMPLE_COUNT);
    expect(new Set(EXAMPLE_QUERIES[corpus]).size).toBe(EXAMPLE_COUNT);
    for (const question of EXAMPLE_QUERIES[corpus]) expect(EXAMPLE_POOL[corpus]).toContain(question);
  }
});

it('picks distinct questions at random and handles small pools', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  expect(pickExamples(pool, 3, () => 0)).toEqual(['a', 'b', 'c']);
  expect(pickExamples(pool, 3, () => 0.999)).toEqual(['e', 'a', 'b']);
  for (let run = 0; run < 50; run++) {
    const picks = pickExamples(pool);
    expect(new Set(picks).size).toBe(3); expect(picks.every(item => pool.includes(item))).toBe(true);
  }
  expect(pickExamples(['only'], 3)).toEqual(['only']);
  expect(pool).toEqual(['a', 'b', 'c', 'd', 'e']);
});
