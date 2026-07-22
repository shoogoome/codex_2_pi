// extensions/monitor/src/cleanup.ts
//
// Consumes {stage, removedChars} payloads emitted by the context-pipeline
// extension on the pi.events "monitor:cleanup" channel and folds them into a
// per-stage token map. The EventBus is untyped and fire-and-forget, so payloads
// are validated defensively and unknown/malformed ones are ignored.
//
// Two accounting kinds live in this map:
//   • GAUGE stages — context-pipeline re-derives these send-time transforms
//     (tool-result-trim, microcompact) from the FULL history on *every* context
//     event and never persists them back to the branch. So each emit is the
//     current per-call snapshot ("how much did this call trim"), not a delta —
//     accumulating them would count the same stale content N times and balloon
//     to bogus millions. These stages therefore REPLACE (latest wins).
//   • Accumulating stages — anything else is treated as a genuine incremental
//     delta and summed (existing behavior preserved).

import { CHARS_PER_TOKEN, isFiniteNumber, isRecord, isString, type CleanupByStage } from "./types.js";

/**
 * Stages whose payload is a per-call gauge (current snapshot) rather than an
 * incremental delta: they are re-reported in full every turn and must REPLACE,
 * not accumulate. Exported so tests can assert the exact membership.
 */
export const GAUGE_STAGES: ReadonlySet<string> = new Set(["microcompact", "tool-result-trim"]);

export interface CleanupPayload {
  stage: string;
  removedChars: number;
}

/** Validate a raw EventBus payload; returns null when malformed. */
export function parseCleanupPayload(data: unknown): CleanupPayload | null {
  if (!isRecord(data)) return null;
  if (!isString(data.stage) || data.stage.length === 0) return null;
  if (!isFiniteNumber(data.removedChars) || data.removedChars <= 0) return null;
  return { stage: data.stage, removedChars: data.removedChars };
}

/**
 * Fold a cleanup payload into a per-stage token map (immutably).
 * removedTokens = round(removedChars / 4), matching context-pipeline's own
 * chars/4 accounting (index.ts: `lastReleasedTokens = round(releasedChars/4)`).
 *
 * GAUGE_STAGES REPLACE the stored value with the latest report (per-call
 * snapshot); all other stages accumulate (`prev + removedTokens`).
 */
export function addCleanup(byStage: CleanupByStage, payload: CleanupPayload): CleanupByStage {
  const removedTokens = Math.round(payload.removedChars / CHARS_PER_TOKEN);
  const next = GAUGE_STAGES.has(payload.stage)
    ? removedTokens
    : (byStage[payload.stage] ?? 0) + removedTokens;
  return {
    ...byStage,
    [payload.stage]: next,
  };
}

/** Total reclaimed tokens across all cleanup stages. */
export function totalCleanupTokens(byStage: CleanupByStage): number {
  return Object.values(byStage).reduce((s, n) => s + (isFiniteNumber(n) ? n : 0), 0);
}
