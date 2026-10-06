export interface GenerationOutput {
  thinking: string;
  answer: string;
  /** True while generation is outside a thinking block. */
  thinkingDone: boolean;
}

const OPEN_THINKING = '<think>';
const CLOSE_THINKING = '</think>';

/**
 * Split cumulative generated text without exposing reasoning as an answer.
 * MiniCPM's thinking template prefills `<think>` in the prompt, so its streamed
 * output normally begins inside that block without an opening tag of its own.
 * Incomplete tag suffixes stay hidden until the next chunk disambiguates them.
 */
export function parseGenerationOutput(raw: string, startsInThinking = true): GenerationOutput {
  const lower = raw.toLowerCase();
  const thinking: string[] = [];
  const answer: string[] = [];
  let inThinking = startsInThinking;
  let start = 0;
  let cursor = 0;

  const append = (end: number): void => {
    if (end > start) (inThinking ? thinking : answer).push(raw.slice(start, end));
  };

  while (cursor < raw.length) {
    if (raw[cursor] !== '<') {
      cursor += 1;
      continue;
    }

    const opening = lower.startsWith(OPEN_THINKING, cursor);
    const closing = lower.startsWith(CLOSE_THINKING, cursor);
    if (opening || closing) {
      append(cursor);
      // Repeated opening tags are redundant when the template already opened
      // the block; another closing tag never makes ordinary answer text hidden.
      inThinking = opening;
      cursor += opening ? OPEN_THINKING.length : CLOSE_THINKING.length;
      start = cursor;
      continue;
    }

    const suffix = lower.slice(cursor);
    if (OPEN_THINKING.startsWith(suffix) || CLOSE_THINKING.startsWith(suffix)) {
      append(cursor);
      return { thinking: thinking.join(''), answer: answer.join(''), thinkingDone: !inThinking };
    }
    cursor += 1;
  }

  append(raw.length);
  return { thinking: thinking.join(''), answer: answer.join(''), thinkingDone: !inThinking };
}
