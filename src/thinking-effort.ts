import type { ThinkingEffort } from './types.ts';

// Off answers directly: about 9 s per reply versus ~40 s with Balanced reasoning
// (MiniCPM5-2B, WebGPU, Apple M-series), because reasoning tokens dominate the wait.
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'off';
// 'balanced' is shown as "Medium" in the UI; the stored value keeps its old name.
export const THINKING_TOKEN_LIMITS = { off: 0, low: 256, balanced: 1024 } as const;

// Validate persisted preferences and worker messages at their boundaries.
export function normalizeThinkingEffort(value: unknown): ThinkingEffort {
  return value === 'off' || value === 'low' || value === 'balanced' ? value : DEFAULT_THINKING_EFFORT;
}
export function thinkingTokenLimit(value: unknown): number {
  return THINKING_TOKEN_LIMITS[normalizeThinkingEffort(value)];
}
