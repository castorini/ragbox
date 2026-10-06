import { describe, expect, it } from 'vitest';
import { parseGenerationOutput } from '../src/generation-output.ts';

describe('parseGenerationOutput', () => {
  it('treats generated text as reasoning when the template prefills the opening tag', () => {
    expect(parseGenerationOutput('The evidence suggests [MED-1].\n')).toEqual({
      thinking: 'The evidence suggests [MED-1].\n',
      answer: '',
      thinkingDone: false,
    });
    expect(parseGenerationOutput('Compare studies [MED-1].</think>Final claim [MED-2].')).toEqual({
      thinking: 'Compare studies [MED-1].',
      answer: 'Final claim [MED-2].',
      thinkingDone: true,
    });
  });

  it('accepts empty reasoning and redundant opening tags', () => {
    expect(parseGenerationOutput('</think>Answer')).toEqual({ thinking: '', answer: 'Answer', thinkingDone: true });
    expect(parseGenerationOutput('<think>First <think>second</think>Answer')).toEqual({
      thinking: 'First second', answer: 'Answer', thinkingDone: true,
    });
  });

  it('preserves direct answers when thinking was not prefilled', () => {
    expect(parseGenerationOutput('Direct answer [MED-1].', false)).toEqual({
      thinking: '', answer: 'Direct answer [MED-1].', thinkingDone: true,
    });
    expect(parseGenerationOutput('', false)).toEqual({ thinking: '', answer: '', thinkingDone: true });
    expect(parseGenerationOutput('')).toEqual({ thinking: '', answer: '', thinkingDone: false });
  });

  it('filters explicit thinking blocks from otherwise direct output', () => {
    expect(parseGenerationOutput('Before <think>hidden [MED-1]</think>after [MED-2].', false)).toEqual({
      thinking: 'hidden [MED-1]', answer: 'Before after [MED-2].', thinkingDone: true,
    });
  });

  it('parses case-insensitive tags and multiple reasoning blocks', () => {
    expect(parseGenerationOutput('<THINK>First\n</tHiNk>One [MED-1]. <Think>Second\n</THINK>Two [MED-2].')).toEqual({
      thinking: 'First\nSecond\n', answer: 'One [MED-1]. Two [MED-2].', thinkingDone: true,
    });
  });

  it('retains the previous final answer while keeping later unfinished reasoning separate', () => {
    expect(parseGenerationOutput('First</think>Answer [MED-1].<think>Interrupted [MED-2]')).toEqual({
      thinking: 'FirstInterrupted [MED-2]', answer: 'Answer [MED-1].', thinkingDone: false,
    });
    expect(parseGenerationOutput('<think>Interrupted [MED-2]', false)).toEqual({
      thinking: 'Interrupted [MED-2]', answer: '', thinkingDone: false,
    });
  });

  it('does not surface control markers or infer that interrupted reasoning is an answer', () => {
    expect(parseGenerationOutput('Unfinished reasoning [MED-1]</thi')).toEqual({
      thinking: 'Unfinished reasoning [MED-1]', answer: '', thinkingDone: false,
    });
    expect(parseGenerationOutput('Reasoning</think>Answer</think> continues')).toEqual({
      thinking: 'Reasoning', answer: 'Answer continues', thinkingDone: true,
    });
  });

  it('hides every incomplete opening and closing marker suffix in either channel', () => {
    for (const marker of ['<think>', '</think>', '<THINK>', '</THINK>']) {
      for (let end = 1; end < marker.length; end += 1) {
        const partial = marker.slice(0, end);
        expect(parseGenerationOutput(`Reasoning${partial}`)).toEqual({
          thinking: 'Reasoning', answer: '', thinkingDone: false,
        });
        expect(parseGenerationOutput(`Answer${partial}`, false)).toEqual({
          thinking: '', answer: 'Answer', thinkingDone: true,
        });
      }
    }
  });

  it('keeps both cumulative channels monotonic across every possible stream boundary', () => {
    const cases = [
      { raw: 'Reasoning [MED-1].\n</think>Answer [MED-2].', prefilled: true },
      { raw: '<think>Reasoning [MED-1]</think>First. <THINK>More</THINK>Second.<thi', prefilled: true },
      { raw: 'First.<think>Reasoning [MED-1]</think>Second [MED-2].<think>Unfinished</thi', prefilled: false },
    ];
    for (const { raw, prefilled } of cases) {
      const complete = parseGenerationOutput(raw, prefilled);
      let previous = { thinking: '', answer: '' };
      for (let end = 0; end <= raw.length; end += 1) {
        const current = parseGenerationOutput(raw.slice(0, end), prefilled);
        expect(current.thinking.startsWith(previous.thinking)).toBe(true);
        expect(current.answer.startsWith(previous.answer)).toBe(true);
        expect(complete.thinking.startsWith(current.thinking)).toBe(true);
        expect(complete.answer.startsWith(current.answer)).toBe(true);
        if (prefilled && end < raw.toLowerCase().indexOf('</think>') + '</think>'.length) {
          expect(current.answer).toBe('');
          expect(current.thinkingDone).toBe(false);
        }
        previous = current;
      }
      expect(previous).toEqual(complete);
    }
  });

  it('preserves ordinary angle brackets, newlines, whitespace, and literal markup as text', () => {
    const text = '  2 < 3\n<div>ordinary text</div>\n<thinking>is not a control tag</thinking>  ';
    expect(parseGenerationOutput(text, false)).toEqual({ thinking: '', answer: text, thinkingDone: true });
    expect(parseGenerationOutput(`Check <the source>\n</think>${text}`)).toEqual({
      thinking: 'Check <the source>\n', answer: text, thinkingDone: true,
    });
  });

  it('releases ambiguous text only once a later character makes it an ordinary string', () => {
    expect(parseGenerationOutput('Answer <thi', false).answer).toBe('Answer ');
    expect(parseGenerationOutput('Answer <third', false).answer).toBe('Answer <third');
    expect(parseGenerationOutput('Reasoning <thi').thinking).toBe('Reasoning ');
    expect(parseGenerationOutput('Reasoning <third').thinking).toBe('Reasoning <third');
  });
});
