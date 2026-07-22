// extensions/cost-usage/src/usage.test.ts
//
// Unit tests for the pure cost/usage accumulation helpers.

import { describe, expect, it } from "vitest";
import {
  accumulateModel,
  canonicalModel,
  coerceUsage,
  costOf,
  dedupKey,
  isCountable,
  rebuildByModelFromBranch,
  totals,
} from "./usage.js";
import { emptyBucket, type UsageLike } from "./types.js";

function usage(partial: Partial<UsageLike>): UsageLike {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...partial,
  };
}

describe("isCountable", () => {
  it("accepts stop / toolUse / length", () => {
    expect(isCountable("stop")).toBe(true);
    expect(isCountable("toolUse")).toBe(true);
    expect(isCountable("length")).toBe(true);
  });
  it("rejects error / aborted / unknown / non-string", () => {
    expect(isCountable("error")).toBe(false);
    expect(isCountable("aborted")).toBe(false);
    expect(isCountable("whatever")).toBe(false);
    expect(isCountable(undefined)).toBe(false);
    expect(isCountable(42)).toBe(false);
  });
});

describe("coerceUsage", () => {
  it("returns null for non-record or missing input/output", () => {
    expect(coerceUsage(null)).toBeNull();
    expect(coerceUsage({ input: 1 })).toBeNull();
    expect(coerceUsage({ output: 1 })).toBeNull();
    expect(coerceUsage({ input: "x", output: 1 })).toBeNull();
  });
  it("defaults cache fields and totalTokens when absent", () => {
    const u = coerceUsage({ input: 10, output: 5 });
    expect(u).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: undefined });
  });
  it("reads nested cost sub-fields", () => {
    const u = coerceUsage({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 20,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    });
    expect(u?.cost?.total).toBe(0.33);
    expect(u?.cost?.input).toBe(0.1);
  });
});

describe("canonicalModel", () => {
  it("prefers model, then responseModel, then fallback, then unknown", () => {
    expect(canonicalModel({ model: "opus-4-8[1m]" })).toBe("opus-4-8[1m]");
    expect(canonicalModel({ responseModel: "sonnet" })).toBe("sonnet");
    expect(canonicalModel({}, "ctx-model")).toBe("ctx-model");
    expect(canonicalModel({})).toBe("unknown");
    expect(canonicalModel(null)).toBe("unknown");
  });
  it("keeps context-window suffix distinct (no normalization)", () => {
    expect(canonicalModel({ model: "claude-opus-4-8[1m]" })).toBe("claude-opus-4-8[1m]");
  });
});

describe("dedupKey", () => {
  it("prefers responseId", () => {
    expect(dedupKey({ responseId: "resp_123", model: "m", usage: {} })).toBe("rid:resp_123");
  });
  it("falls back to synthetic model:turn:totalTokens", () => {
    const key = dedupKey({ model: "m", usage: { input: 1, output: 2, totalTokens: 3 } }, 4);
    expect(key).toBe("syn:m:4:3");
  });
  it("is stable for the same finalized message", () => {
    const msg = { model: "m", usage: { input: 1, output: 2, totalTokens: 3 } };
    expect(dedupKey(msg, 0)).toBe(dedupKey(msg, 0));
  });
});

describe("costOf", () => {
  it("prefers provider cost.total when positive", () => {
    const est = () => 999;
    expect(costOf(usage({ cost: { total: 0.5 } }), est)).toEqual({ total: 0.5, estimated: false });
  });
  it("falls back to the estimator when provider cost is absent/zero", () => {
    expect(costOf(usage({ input: 100, output: 50 }), () => 0.42)).toEqual({ total: 0.42, estimated: true });
    expect(costOf(usage({ cost: { total: 0 } }), () => 0.7)).toEqual({ total: 0.7, estimated: true });
  });
  it("returns 0 (not estimated) when neither provider cost nor estimator produce a value", () => {
    expect(costOf(usage({ input: 1, output: 1 }))).toEqual({ total: 0, estimated: false });
    expect(costOf(usage({ input: 1, output: 1 }), () => 0)).toEqual({ total: 0, estimated: false });
  });
});

describe("accumulateModel + totals", () => {
  it("merges two turns of the same model immutably and ORs estimated", () => {
    let by = {};
    by = accumulateModel(by, "m", usage({ input: 10, output: 5, cacheRead: 80, cacheWrite: 2 }), {
      total: 0.1,
      estimated: false,
    });
    by = accumulateModel(by, "m", usage({ input: 20, output: 3, cacheRead: 40, cacheWrite: 1 }), {
      total: 0.2,
      estimated: true,
    });
    expect(by).toEqual({
      m: { input: 30, output: 8, cacheRead: 120, cacheWrite: 3, costTotal: 0.30000000000000004, turns: 2, estimated: true },
    });
  });
  it("keeps distinct models separate and rolls up totals", () => {
    let by = {};
    by = accumulateModel(by, "a", usage({ input: 10, output: 5 }), { total: 0.1, estimated: false });
    by = accumulateModel(by, "b", usage({ input: 20, output: 5, cacheRead: 10 }), { total: 0.2, estimated: true });
    const t = totals(by);
    expect(t.input).toBe(30);
    expect(t.output).toBe(10);
    expect(t.cacheRead).toBe(10);
    expect(t.tokens).toBe(30 + 10 + 10 + 0);
    expect(t.turns).toBe(2);
    expect(t.estimated).toBe(true);
    expect(t.costTotal).toBeCloseTo(0.3, 10);
  });
  it("empty bucket factory is zeroed", () => {
    expect(emptyBucket()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, turns: 0, estimated: false });
  });
});

describe("rebuildByModelFromBranch", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", model: "a", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 0, totalTokens: 95, cost: { total: 0.1 } } } },
    { type: "message", message: { role: "assistant", model: "a", stopReason: "error", usage: { input: 999, output: 0, totalTokens: 999, cost: { total: 9 } } } },
    { type: "message", message: { role: "assistant", model: "b", stopReason: "toolUse", usage: { input: 20, output: 2, totalTokens: 22, cost: { total: 0.2 } } } },
    { type: "custom", customType: "cost-usage/snapshot", data: {} },
  ];

  it("re-derives per-model buckets, filtering non-countable turns and non-messages", () => {
    const by = rebuildByModelFromBranch(branch);
    expect(Object.keys(by).sort()).toEqual(["a", "b"]);
    expect(by.a.turns).toBe(1); // error turn excluded
    expect(by.a.input).toBe(10);
    expect(by.a.costTotal).toBe(0.1);
    expect(by.b.costTotal).toBe(0.2);
  });

  it("uses the estimator only when provider cost is missing", () => {
    const noCostBranch = [
      { type: "message", message: { role: "assistant", model: "a", stopReason: "stop", usage: { input: 100, output: 50, totalTokens: 150 } } },
    ];
    const by = rebuildByModelFromBranch(noCostBranch, () => 0.5);
    expect(by.a.costTotal).toBe(0.5);
    expect(by.a.estimated).toBe(true);
  });
});
