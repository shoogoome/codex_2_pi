// extensions/monitor/src/format.test.ts
import { describe, it, expect } from "vitest";
import { bar, footerLine, formatTokensCompact, percentOf100, percentText } from "./format.js";

describe("formatTokensCompact", () => {
  it("formats codex-style", () => {
    expect(formatTokensCompact(500)).toBe("500");
    expect(formatTokensCompact(63_876)).toBe("63.9K");
    expect(formatTokensCompact(100_000)).toBe("100K");
    expect(formatTokensCompact(1_830_000)).toBe("1.8M");
  });
});

describe("bar", () => {
  it("fills round(fraction*width) of 20 segments", () => {
    expect(bar(0, 20)).toBe("░".repeat(20));
    expect(bar(1, 20)).toBe("█".repeat(20));
    const half = bar(0.5, 20);
    expect(half).toBe("█".repeat(10) + "░".repeat(10));
    // rounding
    expect(bar(0.14, 20)).toBe("█".repeat(3) + "░".repeat(17)); // round(2.8)=3
  });
  it("clamps out-of-range and non-finite", () => {
    expect(bar(-5, 10)).toBe("░".repeat(10));
    expect(bar(2, 10)).toBe("█".repeat(10));
    expect(bar(Number.NaN, 10)).toBe("░".repeat(10));
  });
});

describe("percentText / percentOf100", () => {
  it("renders fractions and null downgrade", () => {
    expect(percentText(0.824)).toBe("82.4%");
    expect(percentText(0.8)).toBe("80%");
    expect(percentText(null)).toBe("--");
    expect(percentOf100(66)).toBe("66%");
    expect(percentOf100(null)).toBe("--");
  });
});

describe("footerLine", () => {
  it("assembles the three-part footer", () => {
    expect(
      footerLine({ sessionHit: 0.82, ctxPercent: 66, sessionReclaimed: 96_000, avgRatio: 0.71 }),
    ).toBe("cache 82% · ctx 66% · saved 96K(71%)");
  });
  it("downgrades nulls", () => {
    expect(footerLine({ sessionHit: null, ctxPercent: null, sessionReclaimed: 0, avgRatio: null })).toBe(
      "cache -- · ctx -- · saved 0",
    );
  });
});
