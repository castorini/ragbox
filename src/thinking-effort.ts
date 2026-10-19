import type { ThinkingEffort } from './types.ts';

// Off answers directly: about 20 s per reply versus about two minutes with
// thinking on (MiniCPM5-2B, WebGPU, Apple M-series), because reasoning tokens dominate the wait.
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'off';
export const THINKING_TOKEN_LIMITS = { off: 0, on: 1024 } as const;

// Validate persisted preferences and worker messages at their boundaries.
// Saved Low and Medium ('low', 'balanced') preferences from the earlier
// three-level control mean thinking was on; anything else falls back to Off.
export function normalizeThinkingEffort(value: unknown): ThinkingEffort {
  if (value === 'on' || value === 'low' || value === 'balanced') return 'on';
  return DEFAULT_THINKING_EFFORT;
}
export function thinkingTokenLimit(value: unknown): number {
  return THINKING_TOKEN_LIMITS[normalizeThinkingEffort(value)];
}
