// extensions/monitor/src/compaction.ts
//
// Compaction ledger + tokensAfter backfill state machine. Pure functions.
//
// CompactionEntry has no `tokensAfter` field and getContextUsage() returns
// null right after compaction, so the ratio cannot be computed synchronously.
// We open a ledger row in "pending-after" state at session_compact, then
// backfill it from the first post-compaction assistant usage (input+cacheRead),
// which is authoritative but slightly high (it includes the new user turn).

import { estimateChars, estimateStr } from "./composition.js";
import {
  isFiniteNumber,
  isRecord,
  isString,
  type AnyMessage,
  type CompactionLedgerRow,
  type UsageLike,
} from "./types.js";

export interface CompactionEntryLike {
  id?: string;
  summary?: string;
  tokensBefore?: number;
  fromHook?: boolean;
}

/** Open a "pending-after" ledger row from a session_compact entry. */
export function openLedgerRow(
  entry: CompactionEntryLike,
  sessionId: string,
  fromExtension: boolean,
  now: number,
): CompactionLedgerRow {
  const summary = isString(entry.summary) ? entry.summary : "";
  return {
    ts: now,
    sessionId,
    entryId: isString(entry.id) ? entry.id : "",
    // fromExtension/fromHook distinguishes a context-pipeline-driven summary
    // from pi's built-in one; threshold-vs-overflow reason remains a gap.
    stage: fromExtension || entry.fromHook === true ? "compaction/ext" : "compaction/auto",
    tokensBefore: isFiniteNumber(entry.tokensBefore) ? Math.max(0, entry.tokensBefore) : 0,
    tokensAfter: null,
    ratio: null,
    summaryTokens: estimateStr(summary),
    status: "pending-after",
  };
}

/**
 * Backfill a pending row with tokensAfter from the first post-compaction
 * assistant usage. tokensAfter ≈ input + cacheRead (the compacted prompt);
 * it is slightly high because it also carries the new user turn — noted in UI.
 */
export function backfillAfter(row: CompactionLedgerRow, usage: UsageLike): CompactionLedgerRow {
  const after = Math.max(0, usage.input) + Math.max(0, usage.cacheRead);
  const ratio = row.tokensBefore > 0 ? 1 - after / row.tokensBefore : null;
  return { ...row, tokensAfter: after, ratio, status: "complete" };
}

/**
 * Fallback tokensAfter estimate for when the user never speaks again after a
 * compaction (so no post-compaction usage ever arrives): Σ estimate(kept) +
 * summary tokens. estimateContextTokens is not exported from the package root,
 * so we self-sum with the chars/4 estimator.
 */
export function estimateAfterFallback(
  summary: string,
  keptMessages: AnyMessage[],
  estimateMessage?: (m: AnyMessage) => number,
): number {
  const est = estimateMessage ?? estimateAnyMessage;
  let total = estimateStr(summary);
  for (const m of keptMessages) total += est(m);
  return total;
}

/** Minimal chars/4 estimator for a structural message (fallback only). */
export function estimateAnyMessage(msg: AnyMessage): number {
  if (!isRecord(msg)) return 0;
  const content = (msg as { content?: unknown }).content;
  if (isString(content)) return estimateStr(content);
  let chars = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (isRecord(b)) {
        if (isString(b.text)) chars += b.text.length;
        else if (isString(b.thinking)) chars += b.thinking.length;
      }
    }
  }
  const summary = (msg as { summary?: unknown }).summary;
  if (isString(summary)) chars += summary.length;
  return estimateChars(chars);
}

/** discardedRaw = Σ estimate(messagesToSummarize ∪ turnPrefixMessages). */
export function discardedRawTokens(
  messagesToSummarize: AnyMessage[],
  turnPrefixMessages: AnyMessage[],
  estimateMessage?: (m: AnyMessage) => number,
): number {
  const est = estimateMessage ?? estimateAnyMessage;
  let total = 0;
  for (const m of messagesToSummarize) total += est(m);
  for (const m of turnPrefixMessages) total += est(m);
  return total;
}

/**
 * Summary compression rate = summaryTokens / discardedRaw (pi-specific; claude/
 * codex cannot compute this directly). Returns null when nothing was discarded.
 */
export function summaryCompressionRate(summaryTokens: number, discardedRaw: number): number | null {
  if (discardedRaw <= 0) return null;
  return summaryTokens / discardedRaw;
}

/** Aggregate: total reclaimed tokens and average ratio across complete rows. */
export function ledgerSummary(rows: CompactionLedgerRow[]): {
  reclaimed: number;
  avgRatio: number | null;
  completeCount: number;
  pendingCount: number;
} {
  let reclaimed = 0;
  let ratioSum = 0;
  let completeCount = 0;
  let pendingCount = 0;
  for (const r of rows) {
    if (r.status === "pending-after" || r.tokensAfter === null || r.ratio === null) {
      pendingCount += 1;
      continue;
    }
    reclaimed += Math.max(0, r.tokensBefore - r.tokensAfter);
    ratioSum += r.ratio;
    completeCount += 1;
  }
  return {
    reclaimed,
    avgRatio: completeCount > 0 ? ratioSum / completeCount : null,
    completeCount,
    pendingCount,
  };
}
