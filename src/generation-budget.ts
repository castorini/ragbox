/** Counts generated tokens only; the caller must exclude prompt tokens. */
export class GenerationTokenBudget {
  private readonly closingMarker: number[];
  private readonly markerWindowLimit: number;
  private readonly markerWindow: number[] = [];
  private thoughtCount = 0;
  private finalCount = 0;
  private thoughtFinished = false;
  private halted = false;
  private thoughtExhausted = false;

  constructor(
    closeTagIds: number[],
    private readonly thinkingLimit: number,
    private readonly answerLimit: number,
    private readonly decode?: (ids: number[]) => string,
  ) {
    if (!closeTagIds.length || closeTagIds.some(id => !Number.isSafeInteger(id) || id < 0)) {
      throw new RangeError('The closing thinking marker must contain valid token IDs.');
    }
    if (!Number.isSafeInteger(thinkingLimit) || thinkingLimit <= 0) {
      throw new RangeError('The thinking token limit must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(answerLimit) || answerLimit <= 0) {
      throw new RangeError('The answer token limit must be a positive safe integer.');
    }
    this.closingMarker = [...closeTagIds];
    this.markerWindowLimit = Math.max(closeTagIds.length, 8);
  }

  get stopped() { return this.halted; }
  get exhaustedThinking() { return this.thoughtExhausted; }
  get thinkingDone() { return this.thoughtFinished; }
  get thinkingTokens() { return this.thoughtCount; }
  get answerTokens() { return this.finalCount; }

  add(tokens: bigint[] | number[]): void {
    for (const token of tokens) {
      if (this.halted) return;
      const id = Number(token);
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new RangeError('Generated tokens must contain valid token IDs.');
      }

      if (this.thoughtFinished) {
        this.finalCount += 1;
        if (this.finalCount >= this.answerLimit) this.halted = true;
        continue;
      }

      // Delimiter tokens belong to the thinking budget, including when the
      // tokenizer splits the marker or its tokens arrive in separate chunks.
      this.thoughtCount += 1;
      this.markerWindow.push(id);
      if (this.markerWindow.length > this.markerWindowLimit) this.markerWindow.shift();
      const markerSuffix = this.markerWindow.slice(-this.closingMarker.length);
      const canonicalClose = markerSuffix.length === this.closingMarker.length
        && markerSuffix.every((value, index) => value === this.closingMarker[index]);
      // Case variants can be emitted as ordinary tokens instead of MiniCPM's
      // canonical added token. Decode only the short suffix, never the prompt
      // or complete generation. A shared delimiter/answer token is counted
      // conservatively toward the answer cap as well as the thinking cap.
      const decodedClose = this.decode
        ? /<\/think>([\s\S]*)$/i.exec(this.decode([...this.markerWindow]))
        : null;
      if (canonicalClose || decodedClose) {
        this.thoughtFinished = true;
        this.markerWindow.length = 0;
        if (decodedClose?.[1].trim()) {
          this.finalCount += 1;
          if (this.finalCount >= this.answerLimit) this.halted = true;
        }
      } else if (this.thoughtCount >= this.thinkingLimit) {
        this.thoughtExhausted = true;
        this.halted = true;
      }
    }
  }
}
