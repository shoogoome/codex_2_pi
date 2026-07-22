// extensions/context-pipeline/src/autocompactGuard.ts
//
// ④ Autocompact threshold derivation + circuit breaker (pure, no pi deps).
//
//   effectiveWindow = contextWindow - reserveOutput
//   threshold       = effectiveWindow - thresholdBuffer
//
// Autocompaction fires when (tokens - releasedTokens) >= threshold. When
// getContextUsage().tokens is null (right after compaction, before the next
// real usage), estimates are unreliable, so we suppress both autocompaction and
// the context-low hint.

import type { PipelineConfig } from "./config.js";

export interface UsageLike {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface Thresholds {
  effectiveWindow: number;
  threshold: number;
}

export function computeThreshold(contextWindow: number, cfg: PipelineConfig): Thresholds {
  const effectiveWindow = contextWindow - cfg.reserveOutput;
  const threshold = effectiveWindow - cfg.thresholdBuffer;
  return { effectiveWindow, threshold };
}

/**
 * True when the (release-adjusted) token estimate has reached the autocompact
 * threshold. Always false when tokens is unknown or the window is invalid.
 */
export function shouldAutocompact(
  usage: UsageLike | undefined,
  releasedTokens: number,
  cfg: PipelineConfig,
): boolean {
  if (!usage || usage.tokens == null) return false;
  if (!(usage.contextWindow > 0)) return false;
  const { threshold } = computeThreshold(usage.contextWindow, cfg);
  const released = releasedTokens > 0 ? releasedTokens : 0;
  const effective = usage.tokens - released;
  return effective >= threshold;
}

/** Suppress context-low warnings while token usage is unknown. */
export function suppressContextLow(usage: UsageLike | undefined): boolean {
  return !usage || usage.tokens == null;
}

/** Percentage of headroom left before the threshold (0..100), or null. */
export function percentLeft(usage: UsageLike | undefined, cfg: PipelineConfig): number | null {
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return null;
  const { threshold } = computeThreshold(usage.contextWindow, cfg);
  if (threshold <= 0) return 0;
  const left = Math.round(((threshold - usage.tokens) / threshold) * 100);
  return Math.max(0, Math.min(100, left));
}

/**
 * Tracks consecutive compaction failures. Trips after `max` in a row and stops
 * further automatic triggering until a success resets it.
 */
export class CircuitBreaker {
  fails = 0;
  tripped = false;

  constructor(public readonly max: number) {}

  recordSuccess(): void {
    this.fails = 0;
    this.tripped = false;
  }

  /** Records a failure; returns true if this failure trips the breaker. */
  recordFailure(): boolean {
    this.fails++;
    if (this.fails >= this.max) this.tripped = true;
    return this.tripped;
  }
}
