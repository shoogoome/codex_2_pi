// extensions/cost-usage/src/format.test.ts
//
// Unit tests for the pure formatters + overview builder.

import { describe, expect, it } from "vitest";
import {
  buildOverviewLines,
  footerLine,
  formatCost,
  formatDuration,
  formatDurationShort,
  formatTokensCompact,
} from "./format.js";
import type { CostSnapshot } from "./types.js";

describe("formatCost", () => {
  it("renders $0.00 for zero / non-finite", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(NaN)).toBe("$0.00");
    expect(formatCost(Infinity)).toBe("$0.00");
  });
  it("keeps 4 decimals for sub-$1 values", () => {
    expect(formatCost(0.4213)).toBe("$0.4213");
    expect(formatCost(0.00007)).toBe("$0.0001");
  });
  it("uses 2 decimals for values >= $1", () => {
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(1)).toBe("$1.00");
  });
});

describe("formatDuration", () => {
  it("handles boundaries", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * 60_000 + 3_000)).toBe("12m 03s");
    expect(formatDuration(3600_000 + 5 * 60_000)).toBe("1h 05m");
  });
});

describe("formatDurationShort", () => {
  it("is compact for the footer", () => {
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(45_000)).toBe("45s");
    expect(formatDurationShort(12 * 60_000)).toBe("12m");
    expect(formatDurationShort(3600_000 + 5 * 60_000)).toBe("1h5m");
    expect(formatDurationShort(3600_000)).toBe("1h");
  });
});

describe("formatTokensCompact", () => {
  it("renders K / M / B", () => {
    expect(formatTokensCompact(950)).toBe("950");
    expect(formatTokensCompact(63_876)).toBe("63.9K");
    expect(formatTokensCompact(1_830_000)).toBe("1.83M");
    expect(formatTokensCompact(2_500_000_000)).toBe("2.5B");
  });
});

describe("footerLine", () => {
  it("joins cost · tokens · duration", () => {
    expect(footerLine({ costTotal: 0.4213, tokens: 1_200_000, durationMs: 12 * 60_000 })).toBe(
      "$0.4213 · 1.2M tok · 12m",
    );
  });
});

function snap(overrides: Partial<CostSnapshot> = {}): CostSnapshot {
  return {
    sessionId: "abcdef123456",
    byModel: {
      "claude-opus-4-8[1m]": { input: 100, output: 50, cacheRead: 800, cacheWrite: 20, costTotal: 0.42, turns: 3, estimated: false },
    },
    lines: { added: 12, removed: 4, files: ["a.ts", "b.ts"] },
    startedAt: 1000,
    lastActivityAt: 1000 + 90_000,
    updatedAt: 0,
    ...overrides,
  };
}

describe("buildOverviewLines", () => {
  it("renders a no-data line when snapshot is null", () => {
    expect(buildOverviewLines(null)).toEqual(["cost: no data yet"]);
  });
  it("renders TOTAL, per-model row, duration, and edit churn", () => {
    const text = buildOverviewLines(snap()).join("\n");
    expect(text).toContain("/cost");
    expect(text).toContain("TOTAL  $0.42");
    expect(text).toContain("claude-opus-4"); // truncated model id
    expect(text).toContain("duration");
    expect(text).toContain("1m 30s");
    expect(text).toContain("+12");
    expect(text).toContain("-4");
    expect(text).toContain("2 files");
  });
  it("flags estimated totals", () => {
    const s = snap();
    s.byModel["claude-opus-4-8[1m]"].estimated = true;
    const text = buildOverviewLines(s).join("\n");
    expect(text).toContain("(incl. est.)");
    expect(text).toContain("~est");
  });
  it("handles an empty byModel", () => {
    const text = buildOverviewLines(snap({ byModel: {} })).join("\n");
    expect(text).toContain("no assistant turns yet");
  });
});
