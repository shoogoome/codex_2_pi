// extensions/token-speed/src/snapshot.ts
//
// Persistence build + cross-session restore for measured samples. Pure
// functions over branch entries; index.ts is the only place that calls
// pi.appendEntry (a CustomEntry never enters LLM context).
//
// Why persist at all: output tokens are re-derivable from the branch, but the
// *timing* that makes a tok/s number is not. So the samples list is the
// authoritative record of what this session measured, scoped by sessionId to
// avoid fork/reload bleed.

import {
  CUSTOM_TYPE,
  HISTORY_LIMIT,
  isFiniteNumber,
  isRecord,
  isString,
  type ResponseSample,
  type SpeedSnapshot,
} from "./types.js";
import { CHARS_PER_TOKEN_FALLBACK } from "./types.js";
import { clampRatio } from "./measure.js";

function normalizeSample(raw: unknown): ResponseSample | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.outputTokens) || raw.outputTokens <= 0) return null;
  if (!isFiniteNumber(raw.basisMs) || raw.basisMs <= 0) return null;
  const basis = raw.basis === "total" ? "total" : "decode";
  const speed = isFiniteNumber(raw.speed) ? raw.speed : (raw.outputTokens / raw.basisMs) * 1000;
  return {
    ts: isFiniteNumber(raw.ts) ? raw.ts : 0,
    modelKey: isString(raw.modelKey) ? raw.modelKey : "unknown",
    outputTokens: raw.outputTokens,
    reasoningTokens: isFiniteNumber(raw.reasoningTokens) ? raw.reasoningTokens : null,
    ttftMs: isFiniteNumber(raw.ttftMs) ? raw.ttftMs : null,
    decodeMs: isFiniteNumber(raw.decodeMs) ? raw.decodeMs : null,
    totalMs: isFiniteNumber(raw.totalMs) ? raw.totalMs : null,
    basisMs: raw.basisMs,
    basis,
    speed,
    chars: isFiniteNumber(raw.chars) ? raw.chars : 0,
  };
}

export interface RestoredSpeed {
  samples: ResponseSample[];
  charsPerToken: number;
  enabled: boolean;
}

/** Rebuild measured state from the newest snapshot entry of this session. */
export function restoreFromBranch(entries: readonly unknown[], sessionId: string): RestoredSpeed {
  let restored: RestoredSpeed = {
    samples: [],
    charsPerToken: CHARS_PER_TOKEN_FALLBACK,
    enabled: true,
  };

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    if (isString(data.sessionId) && data.sessionId !== sessionId) continue;

    const samples = Array.isArray(data.samples)
      ? data.samples.map(normalizeSample).filter((s): s is ResponseSample => s !== null)
      : [];
    restored = {
      samples: samples.slice(-HISTORY_LIMIT),
      charsPerToken: isFiniteNumber(data.charsPerToken)
        ? clampRatio(data.charsPerToken)
        : CHARS_PER_TOKEN_FALLBACK,
      enabled: data.enabled === false ? false : true,
    };
  }

  return restored;
}

/** Assemble a persistable snapshot from current state. */
export function buildSnapshot(state: {
  sessionId: string;
  samples?: readonly ResponseSample[];
  charsPerToken?: number;
  enabled?: boolean;
  now?: number;
}): SpeedSnapshot {
  return {
    sessionId: state.sessionId,
    samples: state.samples ? state.samples.slice(-HISTORY_LIMIT) : [],
    charsPerToken: clampRatio(state.charsPerToken ?? CHARS_PER_TOKEN_FALLBACK),
    enabled: state.enabled !== false,
    updatedAt: state.now ?? Date.now(),
  };
}
