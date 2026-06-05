// Tests for shared text formatters used by task UI surfaces.
//
// `formatTokens` and `formatDuration` were previously inlined in three
// places (summary.ts, ui/taskPanelRender.ts, teammate/ui/teamWidget.ts).
// Consolidating them — these tests pin the behaviour the consumers expect.

import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens } from "./format-utils.js";

describe("formatTokens", () => {
  it("returns '0 tokens' for 0", () => {
    expect(formatTokens(0)).toBe("0 tokens");
  });

  it("returns '0 tokens' for negative input (defensive)", () => {
    expect(formatTokens(-5)).toBe("0 tokens");
  });

  it("renders <1000 as raw integer with 'tokens' suffix", () => {
    expect(formatTokens(1)).toBe("1 tokens");
    expect(formatTokens(100)).toBe("100 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
  });

  it("renders >=1000 as fixed-1 'k tokens'", () => {
    expect(formatTokens(1000)).toBe("1.0k tokens");
    expect(formatTokens(1500)).toBe("1.5k tokens");
    expect(formatTokens(12_300)).toBe("12.3k tokens");
    expect(formatTokens(100_000)).toBe("100.0k tokens");
  });
});

describe("formatDuration", () => {
  it("clamps negative input to 0s", () => {
    expect(formatDuration(-1000)).toBe("0s");
  });

  it("renders <60s as '<n>s'", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("renders <3600s as '<m>m <s>s'", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("renders >=3600s as '<h>h <m>m'", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(36_000_000)).toBe("10h 0m");
  });
});
