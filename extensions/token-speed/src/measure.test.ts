// extensions/token-speed/src/measure.test.ts
//
// Unit tests for the pure measurement helpers: marker bookkeeping, decode /
// TTFT / total windows, the live estimate, ratio learning, sample building and
// session aggregation.

import { describe, expect, it } from "vitest";
import {
  appendSample,
  buildSample,
  clampRatio,
  decodeMs,
  estimateTokens,
  isCountableStopReason,
  lastSample,
  learnCharsPerToken,
  liveSpeed,
  markDelta,
  markMessageStart,
  markRequestStart,
  newMarkers,
  resetMarkers,
  sessionStats,
  totalMs,
  ttftMs,
  type StreamMarkers,
} from "./measure.js";
import {
  CHARS_PER_TOKEN_FALLBACK,
  CHARS_PER_TOKEN_MAX,
  CHARS_PER_TOKEN_MIN,
  MIN_MEASURE_MS,
  type ResponseSample,
} from "./types.js";

/** Markers for a response that streamed `chars` over `decodeMs` after `ttft`. */
function streamed(chars: number, ttft: number, decode: number, chunks = 4): StreamMarkers {
  const markers = newMarkers();
  markRequestStart(markers, 1_000);
  markMessageStart(markers, 1_000 + ttft);
  const first = 1_000 + ttft;
  const perChunk = Math.ceil(chars / chunks);
  for (let i = 0; i < chunks; i += 1) {
    markDelta(markers, perChunk, first + Math.round((decode * i) / (chunks - 1 || 1)));
  }
  return markers;
}

function sample(overrides: Partial<ResponseSample> = {}): ResponseSample {
  return {
    ts: 1,
    modelKey: "openai-codex/gpt-5.6-sol",
    outputTokens: 100,
    reasoningTokens: null,
    ttftMs: 500,
    decodeMs: 2_000,
    totalMs: 2_500,
    basisMs: 2_000,
    basis: "decode",
    speed: 50,
    chars: 400,
    ...overrides,
  };
}

describe("markers", () => {
  it("tracks first/last delta, chars and delta count", () => {
    const m = newMarkers();
    markDelta(m, 4, 100);
    markDelta(m, 0, 150);
    markDelta(m, 6, 300);
    expect(m.firstDeltaTs).toBe(100);
    expect(m.lastDeltaTs).toBe(300);
    expect(m.chars).toBe(10);
    expect(m.deltas).toBe(3);
  });

  it("resetMarkers clears everything in place", () => {
    const m = streamed(40, 100, 1000);
    resetMarkers(m);
    expect(m).toEqual(newMarkers());
  });

  it("decodeMs is null until something streamed", () => {
    const m = newMarkers();
    markMessageStart(m, 10);
    expect(decodeMs(m)).toBeNull();
    expect(ttftMs(m)).toBeNull();
    markDelta(m, 1, 60);
    expect(decodeMs(m)).toBe(0);
    expect(ttftMs(m)).toBe(50);
  });

  it("ttft prefers the provider request origin, total uses it too", () => {
    const m = streamed(40, 200, 1000);
    expect(ttftMs(m)).toBe(200);
    expect(totalMs(m, 2_400)).toBe(1_400);
  });

  it("falls back to message_start when no request timestamp exists", () => {
    const m = newMarkers();
    markMessageStart(m, 1_000);
    markDelta(m, 40, 1_300);
    expect(ttftMs(m)).toBe(300);
    expect(totalMs(m, 2_000)).toBe(1_000);
  });
});

describe("live estimate", () => {
  it("stays silent until there is enough elapsed time and tokens", () => {
    const m = newMarkers();
    markDelta(m, 400, 1_000);
    expect(liveSpeed(m, 4, 1_100)).toBeNull(); // too early
    expect(liveSpeed(m, 4, 1_600)).toBeCloseTo(166.7, 1); // 100 tok over 600ms
  });

  it("ignores tiny token counts even after enough time", () => {
    const m = newMarkers();
    markDelta(m, 4, 1_000);
    expect(liveSpeed(m, 4, 2_000)).toBeNull();
  });

  it("estimateTokens clamps the ratio", () => {
    expect(estimateTokens(400, 4)).toBe(100);
    expect(estimateTokens(0, 4)).toBe(0);
    expect(estimateTokens(400, 0)).toBe(400 / CHARS_PER_TOKEN_FALLBACK);
  });

  it("clampRatio bounds pathological values", () => {
    expect(clampRatio(0)).toBe(CHARS_PER_TOKEN_FALLBACK);
    expect(clampRatio(-3)).toBe(CHARS_PER_TOKEN_FALLBACK);
    expect(clampRatio(0.1)).toBe(CHARS_PER_TOKEN_MIN);
    expect(clampRatio(99)).toBe(CHARS_PER_TOKEN_MAX);
  });
});

describe("learnCharsPerToken", () => {
  it("moves toward the observed ratio with an EMA", () => {
    const next = learnCharsPerToken(4, 800, 200); // observed 4 → unchanged
    expect(next).toBeCloseTo(4, 5);
    const shifted = learnCharsPerToken(4, 200, 200); // observed 1 → clamped to 1.5
    expect(shifted).toBeLessThan(4);
    expect(shifted).toBeGreaterThan(CHARS_PER_TOKEN_MIN);
  });

  it("ignores samples with too few tokens or no chars", () => {
    expect(learnCharsPerToken(3.5, 400, 4)).toBe(3.5);
    expect(learnCharsPerToken(3.5, 0, 400)).toBe(3.5);
  });
});

describe("buildSample", () => {
  it("uses the decode window when the response streamed", () => {
    const s = buildSample({
      markers: streamed(400, 500, 2_000),
      endTs: 3_700,
      outputTokens: 100,
      reasoningTokens: 20,
      stopReason: "stop",
      modelKey: "openai-codex/gpt-5.6-sol",
    });
    expect(s).not.toBeNull();
    expect(s!.basis).toBe("decode");
    expect(s!.basisMs).toBe(2_000);
    expect(s!.speed).toBeCloseTo(50, 5);
    expect(s!.ttftMs).toBe(500);
    expect(s!.totalMs).toBe(2_700);
    expect(s!.reasoningTokens).toBe(20);
  });

  it("falls back to the request→end window when nothing streamed", () => {
    const m = newMarkers();
    markRequestStart(m, 1_000);
    markMessageStart(m, 1_000);
    const s = buildSample({ markers: m, endTs: 3_000, outputTokens: 60, stopReason: "toolUse", modelKey: "m" });
    expect(s!.basis).toBe("total");
    expect(s!.basisMs).toBe(2_000);
    expect(s!.speed).toBeCloseTo(30, 5);
    expect(s!.decodeMs).toBeNull();
    expect(s!.ttftMs).toBeNull();
  });

  it("rejects error / aborted responses, zero output and unmeasurable windows", () => {
    const markers = streamed(400, 500, 2_000);
    const base = { markers, endTs: 3_700, outputTokens: 100, modelKey: "m" };
    expect(buildSample({ ...base, stopReason: "error" })).toBeNull();
    expect(buildSample({ ...base, stopReason: "aborted" })).toBeNull();
    expect(buildSample({ ...base, stopReason: "stop", outputTokens: 0 })).toBeNull();
    const tooShort = streamed(8, 5, MIN_MEASURE_MS - 100, 2);
    expect(
      buildSample({ markers: tooShort, endTs: 1_100, outputTokens: 4, stopReason: "stop", modelKey: "m" }),
    ).toBeNull();
  });

  it("isCountableStopReason accepts only the trustworthy stop reasons", () => {
    expect(isCountableStopReason("stop")).toBe(true);
    expect(isCountableStopReason("toolUse")).toBe(true);
    expect(isCountableStopReason("length")).toBe(true);
    expect(isCountableStopReason("pending")).toBe(false);
    expect(isCountableStopReason("aborted")).toBe(false);
    expect(isCountableStopReason(undefined)).toBe(false);
  });
});

describe("appendSample / sessionStats", () => {
  it("keeps the newest samples up to the limit", () => {
    let samples: ResponseSample[] = [];
    for (let i = 0; i < 5; i += 1) samples = appendSample(samples, sample({ ts: i }), 3);
    expect(samples.map((s) => s.ts)).toEqual([2, 3, 4]);
    expect(lastSample(samples)!.ts).toBe(4);
    expect(lastSample([])).toBeNull();
  });

  it("weights the average by measured window, not by sample count", () => {
    const stats = sessionStats([
      sample({ outputTokens: 100, basisMs: 2_000, speed: 50 }),
      sample({ outputTokens: 400, basisMs: 4_000, speed: 100 }),
    ]);
    expect(stats.count).toBe(2);
    expect(stats.measured).toBe(2);
    expect(stats.outputTokens).toBe(500);
    expect(stats.basisMs).toBe(6_000);
    expect(stats.speed).toBeCloseTo((500 / 6_000) * 1000, 5);
  });

  it("excludes unmeasured samples from the average but keeps their tokens", () => {
    const stats = sessionStats([
      sample({ speed: null, basisMs: 0, outputTokens: 30 }),
      sample({ outputTokens: 100, basisMs: 2_000, speed: 50 }),
    ]);
    expect(stats.measured).toBe(1);
    expect(stats.outputTokens).toBe(130);
    expect(stats.speed).toBeCloseTo(50, 5);
  });

  it("averages TTFT and reasoning over the samples that report them", () => {
    const stats = sessionStats([
      sample({ ttftMs: 400, reasoningTokens: 10 }),
      sample({ ttftMs: 800, reasoningTokens: null }),
    ]);
    expect(stats.ttftMs).toBeCloseTo(600, 5);
    expect(stats.reasoningTokens).toBe(10);
  });

  it("returns null speed for an empty session", () => {
    const stats = sessionStats([]);
    expect(stats.speed).toBeNull();
    expect(stats.ttftMs).toBeNull();
    expect(stats.count).toBe(0);
  });
});
