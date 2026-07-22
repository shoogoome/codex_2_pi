// extensions/cost-usage/src/snapshot.ts
//
// CostSnapshot persistence build + cross-session restore. Pure functions over
// branch entries. Persistence uses pi.appendEntry<CostSnapshot>(CUSTOM_TYPE) at
// the index.ts boundary — a CustomEntry never enters LLM context.
//
// Restore is split, exactly like monitor/src/snapshot.ts:
//   ① byModel token+cost totals are re-derived directly from assistant usage in
//      the branch (authoritative — never added on top of the snapshot's byModel,
//      which would double-count).
//   ② lines + startedAt + lastActivityAt baseline come from the newest CustomEntry
//      of our customType scoped to `sessionId` (cannot be re-derived from messages).

import { rebuildByModelFromBranch } from "./usage.js";
import {
  CUSTOM_TYPE,
  emptyChurn,
  isFiniteNumber,
  isRecord,
  isString,
  type ByModel,
  type CostSnapshot,
  type LineChurn,
  type UsageLike,
} from "./types.js";

export interface RestoredCost {
  byModel: ByModel;
  lines: LineChurn;
  startedAt: number;
  lastActivityAt: number;
}

function normalizeChurn(raw: unknown): LineChurn {
  if (!isRecord(raw)) return emptyChurn();
  const files = Array.isArray(raw.files) ? raw.files.filter(isString) : [];
  return {
    added: isFiniteNumber(raw.added) ? raw.added : 0,
    removed: isFiniteNumber(raw.removed) ? raw.removed : 0,
    files,
  };
}

/**
 * Rebuild cost state from a session branch, scoped to `sessionId` to avoid
 * fork/reload bleed. `estimator` (optional) fills provider-missing costs when
 * re-deriving byModel.
 */
export function restoreFromBranch(
  entries: readonly unknown[],
  sessionId: string,
  estimator?: (u: UsageLike) => number,
): RestoredCost {
  let lines = emptyChurn();
  let startedAt = 0;
  let lastActivityAt = 0;

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    // Only accept snapshots for this session (or session-agnostic ones).
    if (isString(data.sessionId) && data.sessionId !== sessionId) continue;
    lines = normalizeChurn(data.lines);
    if (isFiniteNumber(data.startedAt)) startedAt = data.startedAt;
    if (isFiniteNumber(data.lastActivityAt)) lastActivityAt = data.lastActivityAt;
  }

  return {
    byModel: rebuildByModelFromBranch(entries, estimator),
    lines,
    startedAt,
    lastActivityAt,
  };
}

/** Assemble a persistable CostSnapshot from current state. */
export function buildSnapshot(state: {
  sessionId: string;
  byModel?: ByModel;
  lines?: LineChurn;
  startedAt?: number;
  lastActivityAt?: number;
  now?: number;
}): CostSnapshot {
  return {
    sessionId: state.sessionId,
    byModel: state.byModel ?? {},
    lines: state.lines ?? emptyChurn(),
    startedAt: state.startedAt ?? 0,
    lastActivityAt: state.lastActivityAt ?? 0,
    updatedAt: state.now ?? Date.now(),
  };
}
