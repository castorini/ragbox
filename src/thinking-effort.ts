import type { ThinkingEffort } from './types.ts';

export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'balanced';
export const THINKING_TOKEN_LIMITS = { low: 256, balanced: 1024, high: 2048 } as const;

// Validate persisted preferences and worker messages at their boundaries.
export function normalizeThinkingEffort(value: unknown): ThinkingEffort {
  return value === 'low' || value === 'balanced' || value === 'high' ? value : DEFAULT_THINKING_EFFORT;
}
export function thinkingTokenLimit(value: unknown): number {
  return THINKING_TOKEN_LIMITS[normalizeThinkingEffort(value)];
}
