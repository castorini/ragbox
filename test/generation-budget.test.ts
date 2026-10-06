import { describe, expect, it, vi } from 'vitest';
import { GenerationTokenBudget } from '../src/generation-budget.ts';

const asciiIds = (text: string) => [...text].map(character => character.charCodeAt(0));
const decodeAscii = (ids: number[]) => String.fromCharCode(...ids);

describe('GenerationTokenBudget', () => {
  it('rejects an empty or invalid closing marker and invalid limits', () => {
    expect(() => new GenerationTokenBudget([], 5, 2)).toThrow('marker');
    for (const ids of [[-1], [1.5], [NaN]]) {
      expect(() => new GenerationTokenBudget(ids, 5, 2)).toThrow('marker');
    }
    for (const limit of [0, -1, 1.5, Infinity]) {
      expect(() => new GenerationTokenBudget([9], limit, 2)).toThrow('thinking token limit');
      expect(() => new GenerationTokenBudget([9], 5, limit)).toThrow('answer token limit');
    }
  });

  it('starts in thinking and separates a single-token marker from the answer', () => {
    const budget = new GenerationTokenBudget([9], 5, 2);
    expect(budget.thinkingDone).toBe(false);
    expect(budget.stopped).toBe(false);
    budget.add([1, 9]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(2);
    expect(budget.answerTokens).toBe(0);
    expect(budget.stopped).toBe(false);
    budget.add([3, 4, 5]);
    expect(budget.answerTokens).toBe(2);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(false);
  });

  it('recognizes a multi-token marker across chunks and counts the answer in the same chunk', () => {
    const budget = new GenerationTokenBudget([7, 8, 9], 10, 2);
    budget.add([1, 7]);
    budget.add([8]);
    expect(budget.thinkingDone).toBe(false);
    budget.add([9, 20]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(4);
    expect(budget.answerTokens).toBe(1);
    budget.add([21]);
    expect(budget.stopped).toBe(true);
    expect(budget.answerTokens).toBe(2);
  });

  it('requires the complete contiguous marker and handles overlapping prefixes', () => {
    const budget = new GenerationTokenBudget([7, 8], 8, 2);
    budget.add([7, 1, 7, 7]);
    expect(budget.thinkingDone).toBe(false);
    budget.add([8]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(5);
    expect(budget.answerTokens).toBe(0);
  });

  it('coerces bigint token IDs without changing phase detection or budgets', () => {
    const budget = new GenerationTokenBudget([9, 10], 5, 2);
    budget.add([1n, 9n]);
    budget.add([10n, 20n, 21n, 22n]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(3);
    expect(budget.answerTokens).toBe(2);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(false);
  });

  it('stops exactly at the thinking cap and ignores later tokens', () => {
    const budget = new GenerationTokenBudget([9], 3, 2);
    budget.add([1, 2, 3, 9, 20]);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(true);
    expect(budget.thinkingDone).toBe(false);
    expect(budget.thinkingTokens).toBe(3);
    expect(budget.answerTokens).toBe(0);
    budget.add([9, 20]);
    expect(budget.thinkingTokens).toBe(3);
    expect(budget.answerTokens).toBe(0);
  });

  it('allows a marker completed exactly at the thinking cap', () => {
    const budget = new GenerationTokenBudget([8, 9], 3, 2);
    budget.add([1, 8, 9]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.stopped).toBe(false);
    expect(budget.exhaustedThinking).toBe(false);
    budget.add([20, 21]);
    expect(budget.stopped).toBe(true);
    expect(budget.answerTokens).toBe(2);
  });

  it('does not accept a marker that remains incomplete at the thinking cap', () => {
    const budget = new GenerationTokenBudget([8, 9], 3, 2);
    budget.add([1, 2, 8, 9]);
    expect(budget.thinkingDone).toBe(false);
    expect(budget.exhaustedThinking).toBe(true);
    expect(budget.thinkingTokens).toBe(3);
    expect(budget.answerTokens).toBe(0);
  });

  it('does not give short thinking extra answer tokens', () => {
    const budget = new GenerationTokenBudget([9], 2048, 512);
    // Only new generated tokens are supplied, never the prompt IDs.
    budget.add([9]);
    budget.add(Array.from({ length: 600 }, () => 20));
    expect(budget.thinkingTokens).toBe(1);
    expect(budget.answerTokens).toBe(512);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(false);
  });

  it('copies the closing marker so caller mutation cannot change detection', () => {
    const marker = [9];
    const budget = new GenerationTokenBudget(marker, 5, 2);
    marker[0] = 10;
    budget.add([9]);
    expect(budget.thinkingDone).toBe(true);
  });

  it.each(['</THINK>', '</tHiNk>'])('recognizes split ordinary tokens for %s', marker => {
    const budget = new GenerationTokenBudget([999], 20, 2, decodeAscii);
    budget.add(asciiIds('idea '));
    budget.add(asciiIds(marker.slice(0, 4)));
    expect(budget.thinkingDone).toBe(false);
    budget.add(asciiIds(marker.slice(4)));
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(5 + marker.length);
    expect(budget.answerTokens).toBe(0);
    budget.add(asciiIds('yes'));
    expect(budget.answerTokens).toBe(2);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(false);
  });

  it('accepts decoded closing tags with trailing whitespace without consuming answer tokens', () => {
    const decode = (ids: number[]) => ids.map(id => id === 999 ? '</THINK>\n  ' : 'thought').join('');
    const budget = new GenerationTokenBudget([1000], 10, 2, decode);
    budget.add([999]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.answerTokens).toBe(0);
  });

  it('counts a token shared by the closing delimiter and answer conservatively toward the final cap', () => {
    const decode = (ids: number[]) => ids.map(id => id === 999 ? '</tHiNk>Answer' : ' next').join('');
    const budget = new GenerationTokenBudget([1000], 10, 2, decode);
    budget.add([999]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.thinkingTokens).toBe(1);
    expect(budget.answerTokens).toBe(1);
    budget.add([1, 2]);
    expect(budget.answerTokens).toBe(2);
    expect(budget.stopped).toBe(true);
  });

  it('keeps unknown or incomplete decoded tags in the thinking phase', () => {
    const budget = new GenerationTokenBudget([999], 100, 512, decodeAscii);
    budget.add(asciiIds('Thought <thought> incomplete </thin> or </THI'));
    expect(budget.thinkingDone).toBe(false);
    expect(budget.answerTokens).toBe(0);
    expect(budget.stopped).toBe(false);
  });

  it('preserves the 512-token answer cap for a noncanonical decoded marker', () => {
    const budget = new GenerationTokenBudget([999], 2048, 512, decodeAscii);
    budget.add(asciiIds('</THINK>'));
    budget.add(Array.from({ length: 600 }, () => 120));
    expect(budget.thinkingTokens).toBe(8);
    expect(budget.answerTokens).toBe(512);
    expect(budget.stopped).toBe(true);
    expect(budget.exhaustedThinking).toBe(false);
  });

  it('decodes only a bounded generated-token suffix', () => {
    const decode = vi.fn(decodeAscii);
    const budget = new GenerationTokenBudget([999], 2048, 512, decode);
    budget.add(asciiIds('A long stream of reasoning without a closing tag'));
    expect(decode.mock.calls.every(([ids]) => ids.length <= 8)).toBe(true);
    expect(decode.mock.calls.at(-1)?.[0]).toEqual(asciiIds('sing tag'));
  });

  it('keeps canonical multi-token marker detection when the decoder window is larger', () => {
    const budget = new GenerationTokenBudget([7, 8], 10, 2, decodeAscii);
    budget.add([1, 2, 3, 7, 8]);
    expect(budget.thinkingDone).toBe(true);
    expect(budget.answerTokens).toBe(0);
  });
});
