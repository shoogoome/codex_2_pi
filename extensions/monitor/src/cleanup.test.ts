// extensions/monitor/src/cleanup.test.ts
import { describe, it, expect } from "vitest";
import { GAUGE_STAGES, addCleanup, parseCleanupPayload, totalCleanupTokens } from "./cleanup.js";

describe("parseCleanupPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(parseCleanupPayload({ stage: "microcompact", removedChars: 400 })).toEqual({
      stage: "microcompact",
      removedChars: 400,
    });
  });
  it("rejects malformed payloads", () => {
    expect(parseCleanupPayload(null)).toBeNull();
    expect(parseCleanupPayload({ stage: "", removedChars: 400 })).toBeNull();
    expect(parseCleanupPayload({ stage: "x", removedChars: 0 })).toBeNull();
    expect(parseCleanupPayload({ stage: "x", removedChars: -10 })).toBeNull();
    expect(parseCleanupPayload({ stage: "x" })).toBeNull();
    expect(parseCleanupPayload({ removedChars: 10 })).toBeNull();
    expect(parseCleanupPayload("nope")).toBeNull();
  });
});

describe("GAUGE_STAGES", () => {
  it("contains exactly the pipeline's per-call snapshot stages", () => {
    expect(GAUGE_STAGES.has("microcompact")).toBe(true);
    expect(GAUGE_STAGES.has("tool-result-trim")).toBe(true);
    // Anything else is treated as an accumulating delta.
    expect(GAUGE_STAGES.has("toolResult/truncate")).toBe(false);
    expect(GAUGE_STAGES.size).toBe(2);
  });
});

describe("addCleanup", () => {
  it("REPLACES gauge stages with the latest report (round(removedChars/4))", () => {
    // Gauge stages are re-reported in full every context event; the map must
    // hold the latest snapshot, never the sum of stale re-reports (the 1M bug).
    let byStage = {};
    byStage = addCleanup(byStage, { stage: "tool-result-trim", removedChars: 400 }); // -> 100
    byStage = addCleanup(byStage, { stage: "tool-result-trim", removedChars: 402 }); // replace -> 101
    byStage = addCleanup(byStage, { stage: "microcompact", removedChars: 800 }); // -> 200
    byStage = addCleanup(byStage, { stage: "microcompact", removedChars: 4_000_000 }); // replace -> 1_000_000
    expect(byStage).toEqual({ "tool-result-trim": 101, microcompact: 1_000_000 });
    // Even a large latest gauge does not compound across turns.
    byStage = addCleanup(byStage, { stage: "microcompact", removedChars: 40 }); // replace -> 10
    expect((byStage as Record<string, number>).microcompact).toBe(10);
  });

  it("ACCUMULATES non-gauge stages (round(removedChars/4) summed)", () => {
    let byStage = {};
    byStage = addCleanup(byStage, { stage: "toolResult/truncate", removedChars: 400 }); // 100
    byStage = addCleanup(byStage, { stage: "toolResult/truncate", removedChars: 200 }); // +50
    expect(byStage).toEqual({ "toolResult/truncate": 150 });
    expect(totalCleanupTokens(byStage)).toBe(150);
  });

  it("mixes gauge (replace) and accumulating stages independently", () => {
    let byStage = {};
    byStage = addCleanup(byStage, { stage: "microcompact", removedChars: 800 }); // 200 (gauge)
    byStage = addCleanup(byStage, { stage: "custom/prune", removedChars: 400 }); // 100 (accumulate)
    byStage = addCleanup(byStage, { stage: "microcompact", removedChars: 400 }); // replace -> 100
    byStage = addCleanup(byStage, { stage: "custom/prune", removedChars: 400 }); // +100 -> 200
    expect(byStage).toEqual({ microcompact: 100, "custom/prune": 200 });
    expect(totalCleanupTokens(byStage)).toBe(300);
  });

  it("does not mutate the input map (gauge or accumulate)", () => {
    const original = { a: 1 };
    const acc = addCleanup(original, { stage: "b", removedChars: 4 });
    expect(original).toEqual({ a: 1 });
    expect(acc).toEqual({ a: 1, b: 1 });

    const base = { microcompact: 999 };
    const gauge = addCleanup(base, { stage: "microcompact", removedChars: 4 });
    expect(base).toEqual({ microcompact: 999 });
    expect(gauge).toEqual({ microcompact: 1 });
  });
});
