// extensions/monitor/src/compaction.test.ts
import { describe, it, expect } from "vitest";
import {
  backfillAfter,
  discardedRawTokens,
  estimateAfterFallback,
  estimateAnyMessage,
  ledgerSummary,
  openLedgerRow,
  summaryCompressionRate,
} from "./compaction.js";
import type { AnyMessage, UsageLike } from "./types.js";

function usage(p: Partial<UsageLike>): UsageLike {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...p };
}

describe("openLedgerRow", () => {
  it("opens a pending-after row with summary tokens and entryId", () => {
    const row = openLedgerRow({ id: "e1", summary: "s".repeat(40), tokensBefore: 10000 }, "sess", false, 123);
    expect(row.status).toBe("pending-after");
    expect(row.tokensAfter).toBeNull();
    expect(row.ratio).toBeNull();
    expect(row.tokensBefore).toBe(10000);
    expect(row.summaryTokens).toBe(10); // 40/4
    expect(row.entryId).toBe("e1");
    expect(row.stage).toBe("compaction/auto");
  });

  it("marks ext stage when fromExtension or fromHook", () => {
    expect(openLedgerRow({ id: "e", summary: "" }, "s", true, 0).stage).toBe("compaction/ext");
    expect(openLedgerRow({ id: "e", summary: "", fromHook: true }, "s", false, 0).stage).toBe("compaction/ext");
  });
});

describe("backfillAfter", () => {
  it("computes tokensAfter=input+cacheRead, ratio=1-after/before, status complete", () => {
    const row = openLedgerRow({ id: "e1", summary: "x", tokensBefore: 10000 }, "s", false, 0);
    const done = backfillAfter(row, usage({ input: 2000, cacheRead: 1000 }));
    expect(done.tokensAfter).toBe(3000);
    expect(done.ratio).toBeCloseTo(1 - 3000 / 10000, 5);
    expect(done.status).toBe("complete");
  });

  it("ratio null when tokensBefore is 0", () => {
    const row = openLedgerRow({ id: "e", summary: "x", tokensBefore: 0 }, "s", false, 0);
    expect(backfillAfter(row, usage({ input: 100 })).ratio).toBeNull();
  });
});

describe("estimateAfterFallback / estimateAnyMessage", () => {
  it("sums kept-message estimates + summary tokens", () => {
    const kept: AnyMessage[] = [
      { role: "user", content: "u".repeat(40) }, // 10
      { role: "assistant", content: [{ type: "text", text: "a".repeat(80) }] }, // 20
    ];
    const total = estimateAfterFallback("s".repeat(40), kept, estimateAnyMessage);
    expect(total).toBe(10 + 10 + 20); // summary(10) + user(10) + assistant(20)
  });
});

describe("discardedRawTokens / summaryCompressionRate", () => {
  it("sums summarize + prefix message estimates", () => {
    const raw = discardedRawTokens(
      [{ role: "user", content: "u".repeat(400) }], // 100
      [{ role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }], // 100
      estimateAnyMessage,
    );
    expect(raw).toBe(200);
    expect(summaryCompressionRate(20, raw)).toBeCloseTo(0.1, 5);
    expect(summaryCompressionRate(20, 0)).toBeNull();
  });
});

describe("ledgerSummary", () => {
  it("aggregates reclaimed + avg ratio over complete rows, counts pending", () => {
    const rows = [
      { ts: 0, sessionId: "s", entryId: "a", stage: "x", tokensBefore: 10000, tokensAfter: 3000, ratio: 0.7, summaryTokens: 10, status: "complete" as const },
      { ts: 0, sessionId: "s", entryId: "b", stage: "x", tokensBefore: 8000, tokensAfter: null, ratio: null, summaryTokens: 5, status: "pending-after" as const },
    ];
    const s = ledgerSummary(rows);
    expect(s.reclaimed).toBe(7000);
    expect(s.avgRatio).toBeCloseTo(0.7, 5);
    expect(s.completeCount).toBe(1);
    expect(s.pendingCount).toBe(1);
  });

  it("avgRatio null with no complete rows", () => {
    expect(ledgerSummary([]).avgRatio).toBeNull();
  });
});
