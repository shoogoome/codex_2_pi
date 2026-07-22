// extensions/monitor/src/snapshot.ts
//
// MonitorSnapshot persistence / replay. Pure functions over branch entries.
//
// Persistence uses pi.appendEntry<MonitorSnapshot>(CUSTOM_TYPE, snap) at the
// index.ts boundary — CustomEntry never enters LLM context (buildSessionContext
// ignores it), so this is the correct metric-history carrier (never
// sendMessage/customMessage, which would burn tokens).

import { sessionCacheFromBranch } from "./usage.js";
import {
  CUSTOM_TYPE,
  emptyAccumulator,
  isFiniteNumber,
  isRecord,
  isString,
  type CacheAccumulator,
  type CleanupByStage,
  type CompactionLedgerRow,
  type CompositionReport,
  type MonitorSnapshot,
  type TurnFact,
} from "./types.js";

export interface RestoredState {
  cache: CacheAccumulator;
  ledger: CompactionLedgerRow[];
  cleanup: CleanupByStage;
  lastTurn: TurnFact | null;
  composition: CompositionReport | null;
}

function normalizeLedgerRow(raw: unknown, sessionId: string): CompactionLedgerRow | null {
  if (!isRecord(raw)) return null;
  const tokensBefore = isFiniteNumber(raw.tokensBefore) ? raw.tokensBefore : 0;
  const tokensAfter = isFiniteNumber(raw.tokensAfter) ? raw.tokensAfter : null;
  const ratio = isFiniteNumber(raw.ratio) ? raw.ratio : null;
  const status = raw.status === "complete" ? "complete" : "pending-after";
  return {
    ts: isFiniteNumber(raw.ts) ? raw.ts : 0,
    sessionId: isString(raw.sessionId) ? raw.sessionId : sessionId,
    entryId: isString(raw.entryId) ? raw.entryId : "",
    stage: isString(raw.stage) ? raw.stage : "compaction/auto",
    tokensBefore,
    tokensAfter,
    ratio,
    summaryTokens: isFiniteNumber(raw.summaryTokens) ? raw.summaryTokens : 0,
    status,
  };
}

function normalizeCleanup(raw: unknown): CleanupByStage {
  const out: CleanupByStage = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isFiniteNumber(v)) out[k] = v;
  }
  return out;
}

function normalizeSnapshotData(raw: unknown, sessionId: string): Partial<RestoredState> {
  if (!isRecord(raw)) return {};
  const ledger: CompactionLedgerRow[] = Array.isArray(raw.ledger)
    ? raw.ledger.map((r) => normalizeLedgerRow(r, sessionId)).filter((r): r is CompactionLedgerRow => r !== null)
    : [];
  const cleanup = normalizeCleanup(raw.cleanup);
  const composition = isRecord(raw.composition) ? (raw.composition as unknown as CompositionReport) : null;
  const lastTurn = isRecord(raw.lastTurn) ? (raw.lastTurn as unknown as TurnFact) : null;
  return { ledger, cleanup, composition, lastTurn };
}

/**
 * Rebuild monitor state from a session branch, scoped to `sessionId` to avoid
 * cross-session (reload/fork) bleed:
 *  ① the ledger / cleanup / lastTurn / composition baseline comes from the most
 *     recent custom entry of our customType, and
 *  ② the cache accumulator is re-derived directly from assistant usage in the
 *     branch (authoritative — preferred over the persisted snapshot).
 */
export function restoreFromBranch(entries: readonly unknown[], sessionId: string): RestoredState {
  let baseline: Partial<RestoredState> = {};
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data;
    // Only accept snapshots for this session (or session-agnostic ones).
    if (isRecord(data) && isString(data.sessionId) && data.sessionId !== sessionId) continue;
    baseline = normalizeSnapshotData(data, sessionId);
  }
  return {
    cache: sessionCacheFromBranch(entries),
    ledger: baseline.ledger ?? [],
    cleanup: baseline.cleanup ?? {},
    lastTurn: baseline.lastTurn ?? null,
    composition: baseline.composition ?? null,
  };
}

/** Assemble a persistable MonitorSnapshot from current state. */
export function buildSnapshot(state: {
  sessionId: string;
  cache?: CacheAccumulator;
  composition?: CompositionReport | null;
  ledger?: CompactionLedgerRow[];
  cleanup?: CleanupByStage;
  lastTurn?: TurnFact | null;
  now?: number;
}): MonitorSnapshot {
  return {
    sessionId: state.sessionId,
    cache: state.cache ?? emptyAccumulator(),
    composition: state.composition ?? null,
    ledger: state.ledger ?? [],
    cleanup: state.cleanup ?? {},
    lastTurn: state.lastTurn ?? null,
    updatedAt: state.now ?? Date.now(),
  };
}
