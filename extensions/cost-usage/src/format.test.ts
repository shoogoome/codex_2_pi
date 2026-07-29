// extensions/cost-usage/src/format.test.ts
//
// Unit tests for the pure formatters + overview builder.

import { describe, expect, it, vi } from "vitest";
import {
  buildOverviewLines,
  footerLine,
  formatCost,
  formatDuration,
  formatDurationShort,
  formatQuotaDuration,
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

describe("formatQuotaDuration", () => {
  it("renders quota/reset periods compactly", () => {
    expect(formatQuotaDuration(0)).toBe("now");
    expect(formatQuotaDuration(300)).toBe("5m");
    expect(formatQuotaDuration(18_000)).toBe("5h");
    expect(formatQuotaDuration(604_800)).toBe("7d");
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
  it("renders Codex quota precision, window timing, session overlap, and credits", () => {
    const now = 2_000_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const text = buildOverviewLines(snap({ startedAt: now - 2 * 3600_000 }), {
      codexSubscription: {
        status: "ready",
        modelKey: "openai-codex:gpt-5.4",
        usage: {
          planType: "pro",
          fetchedAt: now,
          limits: [{
            id: "codex",
            name: "Codex",
            allowed: true,
            limitReached: false,
            primary: {
              usedPercent: 42,
              limitWindowSeconds: 604_800,
              resetAfterSeconds: 6 * 24 * 3600 + 23 * 3600,
              resetAt: now / 1000 + 6 * 24 * 3600 + 23 * 3600,
            },
          }],
          credits: { hasCredits: true, unlimited: false, balance: "9.99" },
        },
      },
    }).join("\n");
    clock.mockRestore();
    expect(text).toContain("CODEX SUBSCRIPTION · PRO");
    expect(text).toContain("whole-percent precision");
    expect(text).toContain("5h limit");
    expect(text).toContain("unavailable · server did not return this window");
    expect(text).toContain("Weekly limit");
    expect(text).toContain("42% used");
    expect(text).toContain("58% left");
    expect(text).toContain("7d window · started 1h ago");
    expect(text).toContain("session began 1h before the current weekly limit window");
    expect(text).toContain("balance 9.99");
  });
  it("labels both 5h and weekly windows when the server returns them", () => {
    const now = Date.now();
    const text = buildOverviewLines(snap(), {
      codexSubscription: {
        status: "ready",
        modelKey: "openai-codex:gpt-5.4",
        usage: {
          planType: "pro",
          fetchedAt: now,
          limits: [{
            id: "codex",
            name: "Codex",
            allowed: true,
            limitReached: false,
            primary: {
              usedPercent: 20,
              limitWindowSeconds: 18_000,
              resetAfterSeconds: 3600,
              resetAt: now / 1000 + 3600,
            },
            secondary: {
              usedPercent: 40,
              limitWindowSeconds: 604_800,
              resetAfterSeconds: 86_400,
              resetAt: now / 1000 + 86_400,
            },
          }],
        },
      },
    }).join("\n");
    expect(text).toContain("5h limit");
    expect(text).toContain("Weekly limit");
    expect(text).not.toContain("server did not return this window");
  });

  it("shows provider-qualified model ids", () => {
    const s = snap({
      byModel: {
        "openai-codex/gpt-5.6-sol": {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 0,
          costTotal: 0,
          turns: 1,
          estimated: false,
        },
      },
    });
    expect(buildOverviewLines(s).join("\n")).toContain("openai-codex/gpt-5.6-sol");
  });
  it("renders loading and unavailable subscription states", () => {
    expect(buildOverviewLines(snap(), { codexSubscription: { status: "loading" } }).join("\n"))
      .toContain("loading subscription quota");
    expect(buildOverviewLines(snap(), {
      codexSubscription: { status: "unavailable", reason: "OAuth required" },
    }).join("\n")).toContain("OAuth required");
  });
});
