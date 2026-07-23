import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  loadWebFetchConfig,
  parsePositiveInt,
} from "./config.js";

describe("parsePositiveInt", () => {
  it("returns the fallback for undefined", () => {
    expect(parsePositiveInt(undefined, 42)).toBe(42);
  });

  it("parses a run of digits (with surrounding whitespace)", () => {
    expect(parsePositiveInt("100", 42)).toBe(100);
    expect(parsePositiveInt("  256  ", 42)).toBe(256);
  });

  it("rejects zero, negatives, decimals and junk → fallback", () => {
    expect(parsePositiveInt("0", 42)).toBe(42); // not > 0
    expect(parsePositiveInt("-5", 42)).toBe(42); // sign not allowed
    expect(parsePositiveInt("12.5", 42)).toBe(42); // decimal not allowed
    expect(parsePositiveInt("abc", 42)).toBe(42);
    expect(parsePositiveInt("10px", 42)).toBe(42);
    expect(parsePositiveInt("", 42)).toBe(42);
  });
});

describe("loadWebFetchConfig", () => {
  it("returns documented defaults for an empty env", () => {
    const c = loadWebFetchConfig({});
    expect(c.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(c.maxChars).toBe(DEFAULT_MAX_CHARS);
    expect(c.cacheMs).toBe(DEFAULT_CACHE_MS);
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(c.userAgent).toBe(DEFAULT_USER_AGENT);
  });

  it("reads each numeric knob from its env var", () => {
    const c = loadWebFetchConfig({
      PI_WEBFETCH_MAX_BYTES: "2048",
      PI_WEBFETCH_MAX_CHARS: "500",
      PI_WEBFETCH_CACHE_MS: "1000",
      PI_WEBFETCH_TIMEOUT_MS: "3000",
    });
    expect(c.maxBytes).toBe(2048);
    expect(c.maxChars).toBe(500);
    expect(c.cacheMs).toBe(1000);
    expect(c.timeoutMs).toBe(3000);
  });

  it("falls back to defaults for malformed numeric env values", () => {
    const c = loadWebFetchConfig({
      PI_WEBFETCH_MAX_BYTES: "0",
      PI_WEBFETCH_MAX_CHARS: "-1",
      PI_WEBFETCH_CACHE_MS: "nope",
      PI_WEBFETCH_TIMEOUT_MS: "6e4",
    });
    expect(c.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(c.maxChars).toBe(DEFAULT_MAX_CHARS);
    expect(c.cacheMs).toBe(DEFAULT_CACHE_MS);
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("uses a custom User-Agent when provided, else the default", () => {
    expect(loadWebFetchConfig({ PI_WEBFETCH_USER_AGENT: "my-agent/1.0" }).userAgent).toBe("my-agent/1.0");
    // Empty / whitespace-only → fall back to the default UA.
    expect(loadWebFetchConfig({ PI_WEBFETCH_USER_AGENT: "   " }).userAgent).toBe(DEFAULT_USER_AGENT);
  });
});
