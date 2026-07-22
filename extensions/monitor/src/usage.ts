// extensions/monitor/src/usage.ts
//
// Cache hit-rate / cost accumulation. Pure functions over `UsageLike` and
// session branch entries; no pi API access.

import {
  COUNTABLE_STOP_REASONS,
  emptyAccumulator,
  isFiniteNumber,
  isRecord,
  type CacheAccumulator,
  type UsageLike,
} from "./types.js";

/**
 * Only "stop" / "toolUse" / "length" assistant turns are trustworthy for cache
 * accounting; "error" / "aborted" carry inflated or partial usage (mirrors the
 * core getAssistantUsage filter).
 */
export function isCountable(stopReason: unknown): boolean {
  return typeof stopReason === "string" && COUNTABLE_STOP_REASONS.includes(stopReason);
}

/** Full prompt token count for a turn: input already excludes cacheRead+cacheWrite. */
export function promptTotal(usage: UsageLike): number {
  return Math.max(0, usage.input) + Math.max(0, usage.cacheRead) + Math.max(0, usage.cacheWrite);
}

/** Per-turn cache hit rate in [0,1]. Returns 0 when no prompt tokens. */
export function turnHitRate(usage: UsageLike): number {
  const total = promptTotal(usage);
  if (total <= 0) return 0;
  return Math.max(0, usage.cacheRead) / total;
}

/** Per-turn cache-write (new cache creation) ratio in [0,1]. */
export function cacheWriteRatio(usage: UsageLike): number {
  const total = promptTotal(usage);
  if (total <= 0) return 0;
  return Math.max(0, usage.cacheWrite) / total;
}

/** Accumulate one assistant turn's usage into a session-level accumulator (immutably). */
export function accumulate(acc: CacheAccumulator, usage: UsageLike): CacheAccumulator {
  return {
    input: acc.input + Math.max(0, usage.input),
    output: acc.output + Math.max(0, usage.output),
    cacheRead: acc.cacheRead + Math.max(0, usage.cacheRead),
    cacheWrite: acc.cacheWrite + Math.max(0, usage.cacheWrite),
    costTotal: acc.costTotal + Math.max(0, usage.cost?.total ?? 0),
    turns: acc.turns + 1,
  };
}

/** Session-level cache hit rate in [0,1]. */
export function sessionHitRate(acc: CacheAccumulator): number {
  const denom = acc.input + acc.cacheRead + acc.cacheWrite;
  if (denom <= 0) return 0;
  return acc.cacheRead / denom;
}

/** Session-level cache-write ratio in [0,1]. */
export function sessionCacheWriteRatio(acc: CacheAccumulator): number {
  const denom = acc.input + acc.cacheRead + acc.cacheWrite;
  if (denom <= 0) return 0;
  return acc.cacheWrite / denom;
}

function coerceUsage(raw: unknown): UsageLike | null {
  if (!isRecord(raw)) return null;
  const input = raw.input;
  const output = raw.output;
  const cacheRead = raw.cacheRead;
  const cacheWrite = raw.cacheWrite;
  if (!isFiniteNumber(input) || !isFiniteNumber(output)) return null;
  const cost = isRecord(raw.cost) && isFiniteNumber(raw.cost.total) ? { total: raw.cost.total } : undefined;
  return {
    input,
    output,
    cacheRead: isFiniteNumber(cacheRead) ? cacheRead : 0,
    cacheWrite: isFiniteNumber(cacheWrite) ? cacheWrite : 0,
    totalTokens: isFiniteNumber(raw.totalTokens) ? raw.totalTokens : input + output,
    cost,
  };
}

/**
 * Rebuild the session cache accumulator directly from branch entries. This is
 * the authoritative reconstruction on cold start / reload: it walks every
 * `message` entry whose assistant message has a countable stop reason and
 * accumulates its usage. `entries` is `ReadonlySessionManager.getBranch()`.
 */
export function sessionCacheFromBranch(entries: readonly unknown[]): CacheAccumulator {
  let acc = emptyAccumulator();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!isCountable(message.stopReason)) continue;
    const usage = coerceUsage(message.usage);
    if (!usage) continue;
    acc = accumulate(acc, usage);
  }
  return acc;
}
