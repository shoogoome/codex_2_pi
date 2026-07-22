// extensions/context-pipeline/src/autocompactGuard.test.ts
import { describe, it, expect } from "vitest";
import {
  computeThreshold,
  shouldAutocompact,
  suppressContextLow,
  percentLeft,
  CircuitBreaker,
  type UsageLike,
} from "./autocompactGuard.js";
import { DEFAULTS, type PipelineConfig } from "./config.js";

const cfg: PipelineConfig = { ...DEFAULTS };

describe("computeThreshold", () => {
  it("derives effectiveWindow = cw - reserveOutput and threshold = effectiveWindow - buffer", () => {
    const { effectiveWindow, threshold } = computeThreshold(200000, cfg);
    expect(effectiveWindow).toBe(200000 - 20000);
    expect(threshold).toBe(200000 - 20000 - 13000); // 167000
  });
});

describe("shouldAutocompact", () => {
  const usage = (tokens: number | null): UsageLike => ({
    tokens,
    contextWindow: 200000,
    percent: null,
  });

  it("is false when tokens is null", () => {
    expect(shouldAutocompact(usage(null), 0, cfg)).toBe(false);
  });

  it("is false when below threshold", () => {
    expect(shouldAutocompact(usage(166999), 0, cfg)).toBe(false);
  });

  it("is true when at/above threshold", () => {
    expect(shouldAutocompact(usage(167000), 0, cfg)).toBe(true);
    expect(shouldAutocompact(usage(180000), 0, cfg)).toBe(true);
  });

  it("subtracts released tokens before comparing", () => {
    // 170000 - 5000 = 165000 < 167000 → false
    expect(shouldAutocompact(usage(170000), 5000, cfg)).toBe(false);
    // 170000 - 2000 = 168000 >= 167000 → true
    expect(shouldAutocompact(usage(170000), 2000, cfg)).toBe(true);
  });

  it("is false for undefined usage or non-positive window", () => {
    expect(shouldAutocompact(undefined, 0, cfg)).toBe(false);
    expect(shouldAutocompact({ tokens: 100, contextWindow: 0 }, 0, cfg)).toBe(false);
  });
});

describe("suppressContextLow", () => {
  it("suppresses when tokens is null or usage missing", () => {
    expect(suppressContextLow(undefined)).toBe(true);
    expect(suppressContextLow({ tokens: null, contextWindow: 200000 })).toBe(true);
  });
  it("does not suppress with a real token count", () => {
    expect(suppressContextLow({ tokens: 1000, contextWindow: 200000 })).toBe(false);
  });
});

describe("percentLeft", () => {
  it("returns null when tokens unknown", () => {
    expect(percentLeft({ tokens: null, contextWindow: 200000 }, cfg)).toBeNull();
  });
  it("computes headroom percentage", () => {
    // threshold 167000, tokens 0 → 100%
    expect(percentLeft({ tokens: 0, contextWindow: 200000 }, cfg)).toBe(100);
    // tokens == threshold → 0%
    expect(percentLeft({ tokens: 167000, contextWindow: 200000 }, cfg)).toBe(0);
  });
});

describe("CircuitBreaker", () => {
  it("trips after max consecutive failures", () => {
    const cb = new CircuitBreaker(3);
    expect(cb.recordFailure()).toBe(false);
    expect(cb.recordFailure()).toBe(false);
    expect(cb.recordFailure()).toBe(true);
    expect(cb.tripped).toBe(true);
  });

  it("resets on success", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.fails).toBe(0);
    expect(cb.tripped).toBe(false);
    // needs 3 more to trip again
    expect(cb.recordFailure()).toBe(false);
    expect(cb.recordFailure()).toBe(false);
    expect(cb.recordFailure()).toBe(true);
  });
});
