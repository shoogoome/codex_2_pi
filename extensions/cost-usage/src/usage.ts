// extensions/cost-usage/src/usage.ts
//
// Pure cost / usage accumulation. No pi API access — operates on `UsageLike`,
// plain message records, and session branch entries so it is fully unit-testable
// with object fakes.

import {
  COUNTABLE_STOP_REASONS,
  UNKNOWN_MODEL,
  emptyBucket,
  isFiniteNumber,
  isRecord,
  isString,
  type ByModel,
  type CostResult,
  type ModelBucket,
  type Totals,
  type UsageLike,
} from "./types.js";

/**
 * Only "stop" / "toolUse" / "length" assistant turns carry trustworthy usage;
 * "error" / "aborted" are inflated or partial (mirrors core getAssistantUsage).
 */
export function isCountable(stopReason: unknown): boolean {
  return typeof stopReason === "string" && COUNTABLE_STOP_REASONS.includes(stopReason);
}

/** Coerce an unknown `usage` blob into a `UsageLike`, or null when unusable. */
export function coerceUsage(raw: unknown): UsageLike | null {
  if (!isRecord(raw)) return null;
  const { input, output } = raw;
  if (!isFiniteNumber(input) || !isFiniteNumber(output)) return null;
  const cacheRead = isFiniteNumber(raw.cacheRead) ? raw.cacheRead : 0;
  const cacheWrite = isFiniteNumber(raw.cacheWrite) ? raw.cacheWrite : 0;
  const totalTokens = isFiniteNumber(raw.totalTokens) ? raw.totalTokens : input + output;
  let cost: UsageLike["cost"];
  if (isRecord(raw.cost)) {
    const c = raw.cost;
    cost = {
      input: isFiniteNumber(c.input) ? c.input : undefined,
      output: isFiniteNumber(c.output) ? c.output : undefined,
      cacheRead: isFiniteNumber(c.cacheRead) ? c.cacheRead : undefined,
      cacheWrite: isFiniteNumber(c.cacheWrite) ? c.cacheWrite : undefined,
      total: isFiniteNumber(c.total) ? c.total : undefined,
    };
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

/**
 * Canonical aggregation key for a message: prefer `model`, then `responseModel`,
 * then the caller-supplied fallback (e.g. ctx.model?.id), then "unknown".
 * The raw model id is kept as-is so differently-priced context windows
 * (e.g. "claude-opus-4-8[1m]") stay separate.
 */
export function canonicalModel(message: unknown, fallback?: string): string {
  if (isRecord(message)) {
    if (isString(message.model) && message.model.length > 0) return message.model;
    if (isString(message.responseModel) && message.responseModel.length > 0) return message.responseModel;
  }
  if (isString(fallback) && fallback.length > 0) return fallback;
  return UNKNOWN_MODEL;
}

/**
 * Stable identity key for de-duplicating a finalized message in the live path.
 * Prefers `responseId`; otherwise a synthetic `${model}:${turnIndex}:${totalTokens}`.
 */
export function dedupKey(message: unknown, turnIndex?: number): string {
  if (isRecord(message) && isString(message.responseId) && message.responseId.length > 0) {
    return `rid:${message.responseId}`;
  }
  const model = canonicalModel(message);
  const usage = isRecord(message) ? coerceUsage(message.usage) : null;
  const tt = usage ? usage.totalTokens : 0;
  const ti = isFiniteNumber(turnIndex) ? turnIndex : "";
  return `syn:${model}:${ti}:${tt}`;
}

/**
 * Resolve the dollar cost of a turn. Prefers the provider-supplied
 * `usage.cost.total` (USD). Only when that is absent/zero and an `estimator` is
 * supplied does it fall back to a local estimate (flagged `estimated:true`).
 */
export function costOf(usage: UsageLike, estimator?: (u: UsageLike) => number): CostResult {
  const provided = usage.cost?.total;
  if (isFiniteNumber(provided) && provided > 0) {
    return { total: provided, estimated: false };
  }
  if (estimator) {
    const est = estimator(usage);
    if (isFiniteNumber(est) && est > 0) {
      return { total: est, estimated: true };
    }
  }
  return { total: isFiniteNumber(provided) ? provided : 0, estimated: false };
}

/** Accumulate one assistant turn into a per-model map (immutably). */
export function accumulateModel(byModel: ByModel, model: string, usage: UsageLike, cost: CostResult): ByModel {
  const prev = byModel[model] ?? emptyBucket();
  const next: ModelBucket = {
    input: prev.input + Math.max(0, usage.input),
    output: prev.output + Math.max(0, usage.output),
    cacheRead: prev.cacheRead + Math.max(0, usage.cacheRead),
    cacheWrite: prev.cacheWrite + Math.max(0, usage.cacheWrite),
    costTotal: prev.costTotal + Math.max(0, cost.total),
    turns: prev.turns + 1,
    estimated: prev.estimated || cost.estimated,
  };
  return { ...byModel, [model]: next };
}

/** Roll up every model bucket into session totals. */
export function totals(byModel: ByModel): Totals {
  const out: Totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costTotal: 0,
    turns: 0,
    tokens: 0,
    estimated: false,
  };
  for (const b of Object.values(byModel)) {
    out.input += b.input;
    out.output += b.output;
    out.cacheRead += b.cacheRead;
    out.cacheWrite += b.cacheWrite;
    out.costTotal += b.costTotal;
    out.turns += b.turns;
    out.estimated = out.estimated || b.estimated;
  }
  out.tokens = out.input + out.output + out.cacheRead + out.cacheWrite;
  return out;
}

/**
 * Authoritatively rebuild the per-model map directly from a session branch. This
 * is the source of truth on cold start / reload / fork: it walks every
 * `message` entry whose assistant message has a countable stop reason and
 * accumulates its usage + provider cost. An optional `estimator` fills in cost
 * for turns whose provider cost is missing. `entries` is getBranch().
 */
export function rebuildByModelFromBranch(
  entries: readonly unknown[],
  estimator?: (u: UsageLike) => number,
): ByModel {
  let byModel: ByModel = {};
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!isCountable(message.stopReason)) continue;
    const usage = coerceUsage(message.usage);
    if (!usage) continue;
    const model = canonicalModel(message);
    const cost = costOf(usage, estimator);
    byModel = accumulateModel(byModel, model, usage, cost);
  }
  return byModel;
}
