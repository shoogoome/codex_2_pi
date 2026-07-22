// extensions/context-pipeline/src/prune.test.ts
import { describe, it, expect } from "vitest";
import {
  parsePruneArgs,
  estimateTokens,
  aggressiveConfig,
  estimatePrune,
  OneShotPrune,
  formatUsage,
  formatStatus,
  formatSoftArmed,
  formatHard,
  usageHint,
  AGGRESSIVE_KEEP_RECENT,
} from "./prune.js";
import { DEFAULTS, type PipelineConfig } from "./config.js";
import { CLEARED_TEXT } from "./microcompact.js";
import type { AnyMessage } from "./types.js";

const cfg: PipelineConfig = { ...DEFAULTS };

function tr(id: string, text: string, tool = "bash"): AnyMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: tool,
    content: [{ type: "text", text }],
    isError: false,
  } as AnyMessage;
}

describe("parsePruneArgs", () => {
  it("defaults empty args to the soft action", () => {
    expect(parsePruneArgs("")).toEqual({ action: "soft", raw: "", unknown: false });
    expect(parsePruneArgs("   ")).toEqual({ action: "soft", raw: "", unknown: false });
  });

  it("parses the three known subcommands (case/space-insensitive)", () => {
    expect(parsePruneArgs("status").action).toBe("status");
    expect(parsePruneArgs("  STATUS ").action).toBe("status");
    expect(parsePruneArgs("soft").action).toBe("soft");
    expect(parsePruneArgs("hard").action).toBe("hard");
    expect(parsePruneArgs("compact").action).toBe("hard"); // alias
  });

  it("falls back to status and flags unknown input", () => {
    const p = parsePruneArgs("wat");
    expect(p.action).toBe("status");
    expect(p.unknown).toBe(true);
    expect(p.raw).toBe("wat");
  });
});

describe("estimateTokens", () => {
  it("approximates chars/4 and never goes negative", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(-50)).toBe(0);
  });
});

describe("aggressiveConfig", () => {
  it("shrinks keepRecent and forces the count trigger", () => {
    const a = aggressiveConfig(cfg);
    expect(a.keepRecent).toBe(AGGRESSIVE_KEEP_RECENT);
    expect(a.microCountThreshold).toBe(-1);
    // other config untouched
    expect(a.compactableTools).toBe(cfg.compactableTools);
    expect(a.gapMs).toBe(cfg.gapMs);
  });

  it("clamps a negative keepRecent to 0 and accepts a custom value", () => {
    expect(aggressiveConfig(cfg, -3).keepRecent).toBe(0);
    expect(aggressiveConfig(cfg, 2).keepRecent).toBe(2);
  });
});

describe("estimatePrune (dry-run)", () => {
  it("reports removedChars/tokens without mutating the input", () => {
    // Below the normal count threshold, so a *normal* dry-run frees nothing...
    const msgs: AnyMessage[] = [];
    for (let i = 0; i < 6; i++) msgs.push(tr(`t${i}`, "0123456789")); // 10 chars each
    const before = JSON.stringify(msgs);

    const normal = estimatePrune(msgs, cfg);
    expect(normal.triggered).toBe(false);
    expect(normal.removedChars).toBe(0);

    // ...but an aggressive dry-run clears all but the newest (keepRecent=1).
    const agg = estimatePrune(msgs, cfg, { aggressive: true });
    expect(agg.triggered).toBe(true);
    expect(agg.cleared).toBe(6 - AGGRESSIVE_KEEP_RECENT); // 5
    expect(agg.removedChars).toBe(5 * 10);
    expect(agg.removedTokens).toBe(estimateTokens(5 * 10));

    // Dry-run must not touch the caller's messages.
    expect(JSON.stringify(msgs)).toBe(before);
    expect((msgs[0] as any).content[0].text).toBe("0123456789");
  });

  it("returns zero for an empty branch", () => {
    const e = estimatePrune([], cfg, { aggressive: true });
    expect(e).toEqual({ triggered: false, cleared: 0, removedChars: 0, removedTokens: 0 });
  });
});

describe("OneShotPrune", () => {
  it("consume() returns true exactly once after arm(), then resets", () => {
    const p = new OneShotPrune();
    expect(p.isArmed).toBe(false);
    expect(p.consume()).toBe(false);

    p.arm();
    expect(p.isArmed).toBe(true);
    expect(p.consume()).toBe(true); // fires once
    expect(p.isArmed).toBe(false);
    expect(p.consume()).toBe(false); // reset afterwards

    // Re-arming works again.
    p.arm();
    expect(p.consume()).toBe(true);
  });
});

describe("formatters", () => {
  const usage = { tokens: 120000, contextWindow: 200000, percent: 60 };

  it("formatUsage renders tokens/window/percent, or an unknown note", () => {
    expect(formatUsage(usage)).toContain("120,000");
    expect(formatUsage(usage)).toContain("200,000");
    expect(formatUsage(usage)).toContain("60%");
    expect(formatUsage({ tokens: null, contextWindow: 200000, percent: null })).toContain("unknown");
    expect(formatUsage(undefined)).toContain("unknown");
  });

  it("formatStatus reflects whether there is anything to prune", () => {
    const some = formatStatus(usage, { triggered: true, cleared: 3, removedChars: 4000, removedTokens: 1000 });
    expect(some).toContain("3 old tool results");
    expect(some).toContain("~1,000 tokens");
    expect(some).toContain("/prune soft");

    const none = formatStatus(usage, { triggered: false, cleared: 0, removedChars: 0, removedTokens: 0 });
    expect(none).toContain("Nothing to prune");
  });

  it("formatSoftArmed reports the expected release", () => {
    const armed = formatSoftArmed(usage, { triggered: true, cleared: 1, removedChars: 2000, removedTokens: 500 });
    expect(armed).toContain("Armed aggressive prune");
    expect(armed).toContain("~500 tokens");
    expect(armed).toContain("1 tool result"); // singular
    expect(armed).not.toContain("1 tool results");

    const armedEmpty = formatSoftArmed(usage, { triggered: false, cleared: 0, removedChars: 0, removedTokens: 0 });
    expect(armedEmpty).toContain("no stale tool results");
  });

  it("formatHard + usageHint", () => {
    expect(formatHard(usage)).toContain("full compaction");
    expect(usageHint()).toContain("/prune");
  });
});
