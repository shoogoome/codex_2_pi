// extensions/monitor/src/usage.test.ts
import { describe, it, expect } from "vitest";
import {
  accumulate,
  cacheWriteRatio,
  isCountable,
  promptTotal,
  sessionCacheFromBranch,
  sessionHitRate,
  turnHitRate,
} from "./usage.js";
import { emptyAccumulator, type UsageLike } from "./types.js";

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
  it("accepts stop/toolUse/length", () => {
    expect(isCountable("stop")).toBe(true);
    expect(isCountable("toolUse")).toBe(true);
    expect(isCountable("length")).toBe(true);
  });
  it("rejects error/aborted/unknown", () => {
    expect(isCountable("error")).toBe(false);
    expect(isCountable("aborted")).toBe(false);
    expect(isCountable(undefined)).toBe(false);
    expect(isCountable(42)).toBe(false);
  });
});

describe("turnHitRate / promptTotal / cacheWriteRatio", () => {
  it("computes cacheRead/(input+cacheRead+cacheWrite)", () => {
    const u = usage({ input: 100, cacheRead: 300, cacheWrite: 100 });
    expect(promptTotal(u)).toBe(500);
    expect(turnHitRate(u)).toBeCloseTo(0.6, 5);
    expect(cacheWriteRatio(u)).toBeCloseTo(0.2, 5);
  });
  it("returns 0 when prompt total is 0", () => {
    expect(turnHitRate(usage({ output: 50 }))).toBe(0);
    expect(cacheWriteRatio(usage({}))).toBe(0);
  });
});

describe("accumulate / sessionHitRate", () => {
  it("sums four fields, cost and turns", () => {
    let acc = emptyAccumulator();
    acc = accumulate(acc, usage({ input: 100, output: 20, cacheRead: 300, cacheWrite: 50, cost: { total: 0.5 } }));
    acc = accumulate(acc, usage({ input: 200, output: 40, cacheRead: 100, cacheWrite: 0, cost: { total: 0.25 } }));
    expect(acc.input).toBe(300);
    expect(acc.cacheRead).toBe(400);
    expect(acc.cacheWrite).toBe(50);
    expect(acc.turns).toBe(2);
    expect(acc.costTotal).toBeCloseTo(0.75, 5);
    // hit = 400 / (300+400+50) = 400/750
    expect(sessionHitRate(acc)).toBeCloseTo(400 / 750, 5);
  });
});

describe("sessionCacheFromBranch", () => {
  it("rebuilds only from countable assistant messages", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hi" } },
      {
        type: "message",
        message: { role: "assistant", stopReason: "toolUse", usage: usage({ input: 100, cacheRead: 300, cacheWrite: 100 }) },
      },
      // error turn should be excluded (would inflate)
      {
        type: "message",
        message: { role: "assistant", stopReason: "error", usage: usage({ input: 9999, cacheRead: 9999 }) },
      },
      // aborted excluded
      {
        type: "message",
        message: { role: "assistant", stopReason: "aborted", usage: usage({ input: 5000 }) },
      },
      {
        type: "message",
        message: { role: "assistant", stopReason: "stop", usage: usage({ input: 200, cacheRead: 200, cacheWrite: 0 }) },
      },
      { type: "custom", customType: "other", data: {} },
    ];
    const acc = sessionCacheFromBranch(entries);
    expect(acc.turns).toBe(2);
    expect(acc.input).toBe(300);
    expect(acc.cacheRead).toBe(500);
    expect(acc.cacheWrite).toBe(100);
    expect(sessionHitRate(acc)).toBeCloseTo(500 / 900, 5);
  });

  it("returns empty accumulator for empty branch", () => {
    expect(sessionCacheFromBranch([])).toEqual(emptyAccumulator());
  });
});
