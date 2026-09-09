// extensions/token-speed/src/format.test.ts
//
// Unit tests for footer / panel rendering and the live-view helper.

import { describe, expect, it } from "vitest";
import {
  buildPanelLines,
  footerLine,
  formatDuration,
  formatSpeed,
  formatTokensCompact,
  liveView,
  summaryLine,
} from "./format.js";
import { newMarkers, markDelta } from "./measure.js";
import type { ResponseSample } from "./types.js";

function sample(overrides: Partial<ResponseSample> = {}): ResponseSample {
  return {
    ts: 1,
    modelKey: "openai-codex/gpt-5.6-sol",
    outputTokens: 1_200,
    reasoningTokens: 800,
    ttftMs: 1_800,
    decodeMs: 28_400,
    totalMs: 30_200,
    basisMs: 28_400,
    basis: "decode",
    speed: 42.25,
    chars: 4_800,
    ...overrides,
  };
}

describe("number formatting", () => {
  it("formats speed by magnitude", () => {
    expect(formatSpeed(42.25)).toBe("42.3");
    expect(formatSpeed(50)).toBe("50");
    expect(formatSpeed(142.4)).toBe("142");
    expect(formatSpeed(1_234)).toBe("1.2K");
    expect(formatSpeed(0)).toBe("--");
    expect(formatSpeed(null)).toBe("--");
    expect(formatSpeed(Number.NaN)).toBe("--");
  });

  it("formats tokens compactly", () => {
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(1_240)).toBe("1.2K");
    expect(formatTokensCompact(1_830_000)).toBe("1.8M");
  });

  it("formats durations", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(1_800)).toBe("1.8s");
    expect(formatDuration(28_400)).toBe("28.4s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
    expect(formatDuration(null)).toBe("--");
  });
});

describe("footerLine", () => {
  it("prefers the live estimate while streaming", () => {
    expect(footerLine({ live: 42.25, last: 10, avg: 20 })).toBe("⚡ ~42.3 tok/s");
  });

  it("shows the last response plus session average when idle", () => {
    expect(footerLine({ live: null, last: 42.25, avg: 38.14 })).toBe("⚡ 42.3 tok/s · avg 38.1");
  });

  it("omits the average when unavailable and falls back to --", () => {
    expect(footerLine({ live: null, last: 42.25, avg: null })).toBe("⚡ 42.3 tok/s");
    expect(footerLine({ live: null, last: null, avg: null })).toBe("⚡ -- tok/s");
  });
});

describe("liveView", () => {
  it("returns null before the first delta", () => {
    expect(liveView({ chars: 100, firstDeltaTs: null }, 4, 5_000)).toBeNull();
  });

  it("converts streamed chars into tokens and speed", () => {
    const view = liveView({ chars: 400, firstDeltaTs: 1_000 }, 4, 2_000);
    expect(view).toEqual({ speed: 100, tokens: 100, elapsedMs: 1_000 });
  });

  it("reads markers produced by the delta path", () => {
    const markers = newMarkers();
    markDelta(markers, 200, 1_000);
    markDelta(markers, 200, 2_000);
    const view = liveView(markers, 4, 3_000);
    expect(view!.tokens).toBe(100);
    expect(view!.speed).toBeCloseTo(50, 5);
  });
});

describe("buildPanelLines", () => {
  it("renders last/session/recent rows", () => {
    const lines = buildPanelLines({
      sessionId: "abcdef123456",
      samples: [sample(), sample({ speed: 38.14, ts: 2 })],
      charsPerToken: 3.94,
      live: null,
    });
    expect(lines[0]).toContain("── /speed ── session abcdef12 ──");
    expect(lines.some((l) => l.includes("LAST") && l.includes("openai-codex/gpt-5.6-sol"))).toBe(true);
    expect(lines.some((l) => l.includes("out 1.2K") && l.includes("ttft 1.8s"))).toBe(true);
    expect(lines.some((l) => l.includes("SESSION") && l.includes("tok/s avg"))).toBe(true);
    expect(lines.some((l) => l.includes("RECENT") && l.includes("38.1 · 42.3"))).toBe(true);
    expect(lines.some((l) => l.includes("LEARNED") && l.includes("3.94 chars/tok"))).toBe(true);
  });

  it("renders a live row while streaming and an empty state otherwise", () => {
    const live = buildPanelLines({
      sessionId: "s",
      samples: [],
      charsPerToken: 4,
      live: { speed: 55.5, tokens: 1_000, elapsedMs: 18_000 },
    });
    expect(live.some((l) => l.includes("LIVE") && l.includes("~55.5 tok/s"))).toBe(true);

    const empty = buildPanelLines({ sessionId: "s", samples: [], charsPerToken: 4, live: null });
    expect(empty.some((l) => l.includes("no response measured yet"))).toBe(true);
  });

  it("applies the theme hook when provided", () => {
    const lines = buildPanelLines(
      { sessionId: "s", samples: [sample()], charsPerToken: 4, live: null },
      { fg: (color, text) => `<${color}>${text}` },
    );
    expect(lines[0]).toContain("<dim>");
  });
});

describe("summaryLine", () => {
  it("reports the footer line for the latest sample", () => {
    expect(summaryLine({ sessionId: "s", samples: [sample()], charsPerToken: 4, live: null })).toBe(
      "⚡ 42.3 tok/s · avg 42.3",
    );
    expect(summaryLine({ sessionId: "s", samples: [], charsPerToken: 4, live: null })).toBe("⚡ -- tok/s");
  });
});
