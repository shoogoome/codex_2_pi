// extensions/cost-usage/src/types.ts
//
// Constants, structural types, guards, and the persisted snapshot data model for
// the cost-usage extension. Everything here is plain data so the pure helpers
// under src/ can be unit-tested with object fakes and never need pi's real
// `AgentMessage` union at runtime.
//
// This extension is a dollar-dimension companion to the monitor extension: it
// aggregates USD cost + per-model token breakdown + session duration + edit/write
// line churn. It deliberately uses DISTINCT footer/widget keys from monitor so
// the two never fight for a UI slot, and it never re-does monitor's cache /
// context / cleanup accounting.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CustomEntry.customType used to persist cost snapshots (never enters LLM context). */
export const CUSTOM_TYPE = "cost-usage/snapshot";

/** Footer status key — DISTINCT from monitor's "monitor" key to avoid clobbering. */
export const STATUS_KEY = "cost";

/** Widget key for the toggleable /cost panel rendered above the editor. */
export const WIDGET_KEY = "cost-panel";

/** Only these stop reasons contribute to cost accounting (filters error/aborted). */
export const COUNTABLE_STOP_REASONS: readonly string[] = ["stop", "toolUse", "length"];

/** Fallback aggregation key when a message carries no model id. */
export const UNKNOWN_MODEL = "unknown";

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Minimal usage shape we consume (subset of pi-ai `Usage`). */
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined;
}

/** Resolved per-turn cost: dollar total plus whether it was estimated locally. */
export interface CostResult {
  total: number;
  estimated: boolean;
}

// ---------------------------------------------------------------------------
// Aggregation data models
// ---------------------------------------------------------------------------

/** Per-canonical-model token + dollar accumulator. */
export interface ModelBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  turns: number;
  /** True if any turn's cost was locally estimated (provider cost absent). */
  estimated: boolean;
}

export type ByModel = Record<string, ModelBucket>;

/** Edit/write line churn accumulator. `files` is a deduped path list (serializable). */
export interface LineChurn {
  added: number;
  removed: number;
  files: string[];
}

/** Persisted cross-session snapshot. Carried by a CustomEntry, ignored by the LLM. */
export interface CostSnapshot {
  sessionId: string;
  byModel: ByModel;
  lines: LineChurn;
  startedAt: number;
  lastActivityAt: number;
  updatedAt: number;
}

/** Rolled-up totals across every model bucket. */
export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  turns: number;
  /** input + output + cacheRead + cacheWrite across all models. */
  tokens: number;
  /** True if any bucket carried an estimated cost. */
  estimated: boolean;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function emptyBucket(): ModelBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, turns: 0, estimated: false };
}

export function emptyChurn(): LineChurn {
  return { added: 0, removed: 0, files: [] };
}
