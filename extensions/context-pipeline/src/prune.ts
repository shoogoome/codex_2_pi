// extensions/context-pipeline/src/prune.ts
//
// Pure helpers for the manual `/prune` command. Everything here is free of pi
// API dependencies so it can be unit-tested with plain objects:
//
//   - parsePruneArgs:   status | soft | hard argument parsing (+ default action)
//   - aggressiveConfig: derive a "soft prune" microcompact config (smaller
//                       keepRecent, count threshold ignored → force clear)
//   - estimatePrune:    dry-run a microcompact and report what it *would* free
//   - OneShotPrune:     one-shot arming state for the next context event
//   - formatters:       display strings for ctx.ui.notify
//
// The manual command is just an immediate/more-aggressive trigger of the SAME
// microcompact used by the automatic pipeline (src/microcompact.ts): a "soft"
// prune arms a one-shot aggressive pass that the very next `context` event
// applies, so old read/bash/grep results are replaced by placeholders before
// the next LLM call.

import type { PipelineConfig } from "./config.js";
import { microcompact } from "./microcompact.js";
import type { AnyMessage } from "./types.js";

export type PruneAction = "status" | "soft" | "hard";

export interface ParsedPrune {
  action: PruneAction;
  /** Normalized (trimmed/lowercased) argument token. */
  raw: string;
  /** True when the argument didn't match a known subcommand. */
  unknown: boolean;
}

/**
 * Parse the `/prune` argument string into an action.
 *
 *   ""        → soft   (default action: immediate aggressive microcompact)
 *   "soft"    → soft
 *   "status"  → status (read-only report)
 *   "hard" |
 *   "compact" → hard   (full structured compaction, == /compact)
 *   <other>   → status, flagged unknown (handler shows a usage hint)
 */
export function parsePruneArgs(args: string): ParsedPrune {
  const raw = (args ?? "").trim().toLowerCase();
  if (raw === "" || raw === "soft") return { action: "soft", raw, unknown: false };
  if (raw === "status") return { action: "status", raw, unknown: false };
  if (raw === "hard" || raw === "compact") return { action: "hard", raw, unknown: false };
  return { action: "status", raw, unknown: true };
}

/**
 * chars→tokens approximation. Mirrors the conservative chars/4 accounting used
 * by index.ts (`lastReleasedTokens`) and the monitor extension (CHARS_PER_TOKEN).
 */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** Recent compactable results kept by an aggressive (soft) prune. */
export const AGGRESSIVE_KEEP_RECENT = 1;

/**
 * Derive an aggressive microcompact config: keep only `keepRecent` (default 1)
 * of the most recent compactable results and ignore the count threshold so any
 * stale compactable result beyond that is cleared.
 *
 * A count of compactable results is always >= 0, so a threshold of -1 makes the
 * microcompact trigger's `count > microCountThreshold` check always true.
 */
export function aggressiveConfig(
  cfg: PipelineConfig,
  keepRecent: number = AGGRESSIVE_KEEP_RECENT,
): PipelineConfig {
  return {
    ...cfg,
    keepRecent: Math.max(0, keepRecent),
    microCountThreshold: -1,
  };
}

export interface PruneEstimate {
  triggered: boolean;
  cleared: number;
  removedChars: number;
  removedTokens: number;
}

/**
 * Dry-run a microcompact over `messages` and report what it *would* free,
 * without applying the change (the returned `messages` array is discarded).
 *
 * `aggressive` uses aggressiveConfig (soft-prune behavior); otherwise the
 * pipeline's normal config is used. `now` is only relevant to microcompact's
 * idle-gap trigger and is omitted by default (count-based estimate).
 */
export function estimatePrune(
  messages: AnyMessage[],
  cfg: PipelineConfig,
  opts: { aggressive?: boolean; keepRecent?: number; now?: number } = {},
): PruneEstimate {
  const effective = opts.aggressive ? aggressiveConfig(cfg, opts.keepRecent) : cfg;
  const r = microcompact(messages, effective, opts.now);
  return {
    triggered: r.triggered,
    cleared: r.cleared,
    removedChars: r.removedChars,
    removedTokens: estimateTokens(r.removedChars),
  };
}

/**
 * One-shot arming for an aggressive prune. `arm()` requests that the next
 * `context` event run an aggressive microcompact; `consume()` returns true
 * exactly once after arming, then resets — so the aggressive pass fires on the
 * next LLM call only, and normal pruning resumes afterwards.
 */
export class OneShotPrune {
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** Returns true exactly once after arm(); subsequent calls return false. */
  consume(): boolean {
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}

// --- display formatting (pure) ---------------------------------------------

export interface UsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** One-line context usage summary, or an "unknown" note post-compaction. */
export function formatUsage(usage: UsageSnapshot | undefined): string {
  if (!usage || usage.tokens == null) {
    return "Context usage unknown (likely just compacted).";
  }
  const pct = usage.percent != null ? ` (${usage.percent}%)` : "";
  const win = usage.contextWindow > 0 ? ` / ${fmt(usage.contextWindow)}` : "";
  return `Context: ${fmt(usage.tokens)}${win} tokens${pct}.`;
}

/** Read-only status line: usage + what a soft prune would free. */
export function formatStatus(usage: UsageSnapshot | undefined, est: PruneEstimate): string {
  const head = formatUsage(usage);
  if (est.cleared > 0) {
    return `${head} Soft prune would clear ${est.cleared} old tool result${plural(
      est.cleared,
    )} (~${fmt(est.removedTokens)} tokens). Run /prune soft.`;
  }
  return `${head} Nothing to prune (no stale tool results).`;
}

/** Soft-prune confirmation line: usage + expected release on the next call. */
export function formatSoftArmed(usage: UsageSnapshot | undefined, est: PruneEstimate): string {
  const head = formatUsage(usage);
  if (est.cleared > 0) {
    return `${head} Armed aggressive prune: ~${fmt(est.removedTokens)} tokens (${est.cleared} tool result${plural(
      est.cleared,
    )}) will be freed on the next model call.`;
  }
  return `${head} Armed aggressive prune (no stale tool results to clear right now).`;
}

/** Hard-prune confirmation line. */
export function formatHard(usage: UsageSnapshot | undefined): string {
  return `${formatUsage(usage)} Running full compaction…`;
}

export function usageHint(): string {
  return "Usage: /prune [status | soft | hard]";
}
