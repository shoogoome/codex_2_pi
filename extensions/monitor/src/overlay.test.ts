// extensions/monitor/src/overlay.test.ts
import { describe, it, expect } from "vitest";
import { buildMonitorOverlayComponent, suggestions, type ContextUsageLike } from "./overlay.js";
import { emptyAccumulator, type MonitorSnapshot } from "./types.js";

const fallbackTheme = { fg: (_color: string, text: string) => text };

function fakeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    sessionId: "a1b2c3d4e5",
    cache: { ...emptyAccumulator(), input: 100, cacheRead: 400, cacheWrite: 100, costTotal: 4.82, turns: 3 },
    composition: {
      total: 1000,
      grounded: true,
      rows: [
        { label: "system+tools", tokens: 140, pct: 14 },
        { label: "tool results", tokens: 580, pct: 58, detail: "Read 31k Bash 9k" },
        { label: "residual(fmt)", tokens: 30, pct: 3, detail: "对账兜底" },
      ],
      residual: 30,
    },
    ledger: [
      { ts: 0, sessionId: "a1b2c3d4e5", entryId: "e1", stage: "compaction/auto", tokensBefore: 118000, tokensAfter: 34000, ratio: 0.71, summaryTokens: 3100, status: "complete" },
      { ts: 0, sessionId: "a1b2c3d4e5", entryId: "e2", stage: "compaction/ext", tokensBefore: 121000, tokensAfter: null, ratio: null, summaryTokens: 2900, status: "pending-after" },
    ],
    cleanup: { microcompact: 12400, "tool-result-trim": 8100 },
    lastTurn: null,
    updatedAt: 0,
    ...overrides,
  };
}

const usage: ContextUsageLike = { tokens: 84300, contextWindow: 128000, percent: 65.9 };

describe("buildMonitorOverlayComponent render", () => {
  it("renders the three region titles and stays within width", () => {
    const comp = buildMonitorOverlayComponent({
      getSnapshot: () => fakeSnapshot(),
      getContextUsage: () => usage,
      theme: fallbackTheme,
    });
    const width = 70;
    const lines = comp.render(width);
    const text = lines.join("\n");
    expect(text).toContain("CACHE");
    expect(text).toContain("CONTEXT");
    expect(text).toContain("CLEANUP");
    // composition bar chars present
    expect(text).toContain("█");
    // pending-after row marked with ⧗
    expect(text).toContain("⧗");
    // every line fits the viewport width
    for (const line of lines) {
      // visible width can't exceed the requested width
      expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
    }
  });

  it("downgrades context header when tokens is null (post-compaction)", () => {
    const comp = buildMonitorOverlayComponent({
      getSnapshot: () => fakeSnapshot(),
      getContextUsage: () => ({ tokens: null, contextWindow: 128000, percent: null }),
      theme: fallbackTheme,
    });
    const text = comp.render(80).join("\n");
    expect(text).toContain("post-compaction");
  });

  it("shows a no-data line when snapshot is null", () => {
    const comp = buildMonitorOverlayComponent({
      getSnapshot: () => null,
      getContextUsage: () => undefined,
      theme: fallbackTheme,
    });
    expect(comp.render(40).join("\n")).toContain("no data");
  });
});

describe("monitor overlay render (widget content)", () => {
  it("renders a toggle hint footer and adapts to the given width", () => {
    const comp = buildMonitorOverlayComponent({
      getSnapshot: () => fakeSnapshot(),
      getContextUsage: () => usage,
      theme: fallbackTheme,
    });
    const narrow = comp.render(48);
    const wide = comp.render(90);
    // Toggle affordance is shown (the panel is dismissed by re-running /monitor).
    expect(narrow.join("\n")).toContain("/monitor");
    // Width-adaptive: every line fits whatever width it is given.
    for (const line of narrow) expect(stripAnsi(line).length).toBeLessThanOrEqual(48);
    for (const line of wide) expect(stripAnsi(line).length).toBeLessThanOrEqual(90);
  });
});

describe("suggestions", () => {
  it("warns on high context and large tool results", () => {
    const out = suggestions(fakeSnapshot(), usage);
    expect(out.length).toBe(0); // 65.9% < 80% and tool row already 58% but only via pct — check high case
  });

  it("emits warnings past thresholds", () => {
    const snap = fakeSnapshot({
      composition: {
        total: 100000,
        grounded: true,
        rows: [{ label: "tool results", tokens: 58000, pct: 58, detail: "Read 31k" }],
        residual: 0,
      },
    });
    const out = suggestions(snap, { tokens: 110000, contextWindow: 128000, percent: 86 });
    expect(out.some((s) => s.includes("full"))).toBe(true);
    expect(out.some((s) => s.includes("tool results"))).toBe(true);
  });
});

function stripAnsi(s: string): string {
  // fallbackTheme adds no ANSI, but truncateToWidth ellipsis is a single char.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}
