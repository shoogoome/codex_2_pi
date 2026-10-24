import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_CONTENT_CHARS,
  isSearchEnabled,
  loadWebFetchConfig,
  parseBool,
  parseClampedInt,
  parseDeepSeekFetchMode,
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

describe("parseClampedInt", () => {
  it("clamps into range instead of falling back", () => {
    expect(parseClampedInt("100", 8, 1, 50)).toBe(50);
    expect(parseClampedInt("3", 8, 1, 50)).toBe(3);
    // "0" is not a positive int, so it falls back to 8, which is already in range.
    expect(parseClampedInt("0", 8, 1, 50)).toBe(8);
  });

  it("falls back for junk, then clamps the fallback", () => {
    expect(parseClampedInt("abc", 8, 1, 50)).toBe(8);
    expect(parseClampedInt(undefined, 99, 1, 50)).toBe(50);
  });
});

describe("parseBool", () => {
  it("accepts the usual spellings", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) expect(parseBool(v, false)).toBe(true);
    for (const v of ["0", "false", "No", " off "]) expect(parseBool(v, true)).toBe(false);
  });

  it("falls back for unknown/absent values", () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool("maybe", false)).toBe(false);
  });
});

describe("parseDeepSeekFetchMode", () => {
  it("accepts auto / always / off", () => {
    expect(parseDeepSeekFetchMode("auto")).toBe("auto");
    expect(parseDeepSeekFetchMode(" ALWAYS ")).toBe("always");
    expect(parseDeepSeekFetchMode("off")).toBe("off");
  });

  it("falls back to auto for unknown values", () => {
    expect(parseDeepSeekFetchMode("sometimes")).toBe("auto");
    expect(parseDeepSeekFetchMode(undefined)).toBe("auto");
  });
});

describe("loadWebFetchConfig", () => {
  it("returns documented defaults for an empty env", () => {
    const c = loadWebFetchConfig({});
    expect(c.deepseekBaseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    expect(c.deepseekApiKey).toBeUndefined();
    expect(c.searchCount).toBe(DEFAULT_SEARCH_COUNT);
    expect(c.searchNeedContent).toBe(false);
    expect(c.searchContentChars).toBe(DEFAULT_SEARCH_CONTENT_CHARS);
    expect(c.deepseekFetch).toBe("auto");
    expect(isSearchEnabled(c)).toBe(false);
  });

  it("reads each numeric knob from its env var", () => {
    const c = loadWebFetchConfig({
      PI_WEBFETCH_MAX_BYTES: "2048",
      PI_WEBFETCH_MAX_CHARS: "500",
      PI_WEBFETCH_CACHE_MS: "1000",
      PI_WEBFETCH_TIMEOUT_MS: "3000",
      PI_WEBFETCH_SEARCH_COUNT: "12",
      PI_WEBFETCH_SEARCH_CONTENT_CHARS: "300",
    });
    expect(c.maxBytes).toBe(2048);
    expect(c.maxChars).toBe(500);
    expect(c.cacheMs).toBe(1000);
    expect(c.timeoutMs).toBe(3000);
    expect(c.searchCount).toBe(12);
    expect(c.searchContentChars).toBe(300);
  });

  it("falls back to defaults for malformed numeric env values", () => {
    const c = loadWebFetchConfig({
      PI_WEBFETCH_MAX_BYTES: "0",
      PI_WEBFETCH_MAX_CHARS: "-1",
      PI_WEBFETCH_CACHE_MS: "nope",
      PI_WEBFETCH_TIMEOUT_MS: "6e4",
    });
    expect(c.maxBytes).toBe(10 * 1024 * 1024);
    expect(c.maxChars).toBe(100_000);
    expect(c.cacheMs).toBe(15 * 60 * 1000);
    expect(c.timeoutMs).toBe(60_000);
  });

  it("picks up DEEPSEEK_API_KEY and prefers PI_WEBFETCH_DEEPSEEK_API_KEY", () => {
    expect(loadWebFetchConfig({ DEEPSEEK_API_KEY: "sk-a" }).deepseekApiKey).toBe("sk-a");
    expect(
      loadWebFetchConfig({ DEEPSEEK_API_KEY: "sk-a", PI_WEBFETCH_DEEPSEEK_API_KEY: "sk-b" }).deepseekApiKey,
    ).toBe("sk-b");
    // Whitespace-only values are treated as absent.
    expect(loadWebFetchConfig({ DEEPSEEK_API_KEY: "   " }).deepseekApiKey).toBeUndefined();
    expect(isSearchEnabled(loadWebFetchConfig({ DEEPSEEK_API_KEY: "sk-a" }))).toBe(true);
  });

  it("honours DEEPSEEK_BASE_URL for self-hosted / proxied endpoints", () => {
    expect(loadWebFetchConfig({ DEEPSEEK_BASE_URL: "https://proxy.example/v1" }).deepseekBaseUrl).toBe(
      "https://proxy.example/v1",
    );
    expect(
      loadWebFetchConfig({ DEEPSEEK_BASE_URL: "https://a.example", PI_WEBFETCH_DEEPSEEK_BASE_URL: "https://b.example" })
        .deepseekBaseUrl,
    ).toBe("https://b.example");
  });

  it("parses need-content and the page-fallback mode", () => {
    const c = loadWebFetchConfig({
      PI_WEBFETCH_SEARCH_NEED_CONTENT: "true",
      PI_WEBFETCH_DEEPSEEK_FETCH: "always",
    });
    expect(c.searchNeedContent).toBe(true);
    expect(c.deepseekFetch).toBe("always");
  });

  it("uses a custom User-Agent when provided, else the default", () => {
    expect(loadWebFetchConfig({ PI_WEBFETCH_USER_AGENT: "my-agent/1.0" }).userAgent).toBe("my-agent/1.0");
    expect(loadWebFetchConfig({ PI_WEBFETCH_USER_AGENT: "   " }).userAgent).toContain("pi-webfetch/");
  });
});
