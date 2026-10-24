import { describe, expect, it, vi } from "vitest";
import { loadWebFetchConfig, type WebFetchConfig } from "./config.js";
import { createCache } from "./cache.js";
import type { FetchImpl, FetchResponseLike, WebFetchResult } from "./fetch.js";
import { MIN_LOCAL_TEXT_CHARS, loadPage, needsRemoteFallback } from "./page.js";

function encoder(): TextEncoder {
  return new TextEncoder();
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
      } else controller.close();
    },
  });
}

function htmlResponse(text: string, status = 200): FetchResponseLike {
  return {
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
    body: streamOf(text),
  };
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    status,
    headers: { get: () => "application/json" },
    body: streamOf(JSON.stringify(body)),
  };
}

const LONG_TEXT = `<html><body><p>${"readable prose. ".repeat(40)}</p></body></html>`;
const THIN_TEXT = "<html><body><div id='root'></div></body></html>";

const base = loadWebFetchConfig({});

function configWith(overrides: Partial<WebFetchConfig>): WebFetchConfig {
  return { ...base, deepseekApiKey: "sk-test", ...overrides };
}

/** A local fetch that always returns the given HTML body. */
function localFetch(html: string, status = 200) {
  const impl: FetchImpl = async () => htmlResponse(html, status);
  return impl;
}

/** A DeepSeek Fetch that returns the given markdown page. */
function remoteFetch(title: string, content: string) {
  const impl: FetchImpl = async (url) => {
    if (!url.includes("/v1/tools/fetch")) throw new Error(`unexpected URL ${url}`);
    return jsonResponse({ title, content });
  };
  return impl;
}

describe("needsRemoteFallback", () => {
  const page = (over: Partial<WebFetchResult>): WebFetchResult => ({
    url: "https://example.com",
    code: 200,
    bytes: 10,
    result: "x".repeat(MIN_LOCAL_TEXT_CHARS),
    contentType: "text/html",
    redirected: false,
    truncated: false,
    ...over,
  });

  it("accepts a page with enough extracted text", () => {
    expect(needsRemoteFallback(page({}))).toBe(false);
  });

  it("falls back for HTTP errors, thin bodies and binary placeholders", () => {
    expect(needsRemoteFallback(page({ code: 403 }))).toBe(true);
    expect(needsRemoteFallback(page({ result: "short chrome" }))).toBe(true);
    expect(needsRemoteFallback(page({ result: "[Binary content (application/pdf, 42 bytes) not fetched]" }))).toBe(true);
  });

  it("does NOT fall back for a deliberate cross-host redirect notice", () => {
    expect(needsRemoteFallback(page({ code: 302, result: "REDIRECT DETECTED: https://other.example/ — call webfetch again" }))).toBe(
      false,
    );
  });
});

describe("loadPage — auto (default)", () => {
  it("uses the local result when it has enough text and never calls DeepSeek", async () => {
    const remote = vi.fn(remoteFetch("remote", "remote body"));
    const res = await loadPage({
      url: "https://example.com/doc",
      config: configWith({}),
      fetchImpl: localFetch(LONG_TEXT),
      deepseekFetchImpl: remote as unknown as FetchImpl,
    });
    expect(res.via).toBe("local");
    expect(res.result).toContain("readable prose");
    expect(remote).not.toHaveBeenCalled();
  });

  it("falls back to DeepSeek Fetch when the local body is a JS shell", async () => {
    const res = await loadPage({
      url: "https://spa.example.com/app",
      config: configWith({}),
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: remoteFetch("Rendered", "# Rendered\n\nReal content."),
    });
    expect(res.via).toBe("deepseek");
    expect(res.title).toBe("Rendered");
    expect(res.result).toContain("Real content");
  });

  it("keeps the origin HTTP status when DeepSeek rescues a 403", async () => {
    const res = await loadPage({
      url: "https://blocked.example.com/a",
      config: configWith({}),
      fetchImpl: localFetch("Forbidden", 403),
      deepseekFetchImpl: remoteFetch("T", "rescued body"),
    });
    expect(res.code).toBe(403);
    expect(res.result).toBe("rescued body");
  });

  it("returns the local result when DeepSeek Fetch fails", async () => {
    const failing: FetchImpl = async () => {
      throw new Error("deepseek down");
    };
    const res = await loadPage({
      url: "https://spa.example.com/app",
      config: configWith({}),
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: failing,
    });
    expect(res.via).toBe("local");
  });

  it("returns the local result when DeepSeek returns an empty page", async () => {
    const res = await loadPage({
      url: "https://spa.example.com/app",
      config: configWith({}),
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: remoteFetch("", "   "),
    });
    expect(res.via).toBe("local");
  });

  it("never calls DeepSeek when no API key is configured", async () => {
    const remote = vi.fn(remoteFetch("r", "r"));
    const res = await loadPage({
      url: "https://spa.example.com/app",
      config: loadWebFetchConfig({}),
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: remote as unknown as FetchImpl,
    });
    expect(res.via).toBe("local");
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("loadPage — always / off", () => {
  it("'always' prefers DeepSeek Fetch even when the local body is rich", async () => {
    const res = await loadPage({
      url: "https://example.com/doc",
      config: configWith({ deepseekFetch: "always" }),
      fetchImpl: localFetch(LONG_TEXT),
      deepseekFetchImpl: remoteFetch("R", "remote wins"),
    });
    expect(res.via).toBe("deepseek");
    expect(res.result).toBe("remote wins");
  });

  it("'always' falls back to the local pipeline when DeepSeek fails", async () => {
    const failing: FetchImpl = async () => {
      throw new Error("nope");
    };
    const res = await loadPage({
      url: "https://example.com/doc",
      config: configWith({ deepseekFetch: "always" }),
      fetchImpl: localFetch(LONG_TEXT),
      deepseekFetchImpl: failing,
    });
    expect(res.via).toBe("local");
    expect(res.result).toContain("readable prose");
  });

  it("'off' is purely local even with a key and a JS shell", async () => {
    const remote = vi.fn(remoteFetch("r", "r"));
    const res = await loadPage({
      url: "https://spa.example.com/app",
      config: configWith({ deepseekFetch: "off" }),
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: remote as unknown as FetchImpl,
    });
    expect(res.via).toBe("local");
    expect(remote).not.toHaveBeenCalled();
  });

  it("never hands an internal URL to DeepSeek, even in 'always' mode", async () => {
    const remote = vi.fn(remoteFetch("r", "r"));
    await expect(
      loadPage({
        url: "http://169.254.169.254/latest/meta-data/",
        config: configWith({ deepseekFetch: "always" }),
        fetchImpl: localFetch(LONG_TEXT),
        deepseekFetchImpl: remote as unknown as FetchImpl,
      }),
    ).rejects.toThrow(/webfetch:/);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("loadPage — caps and caching", () => {
  it("clamps DeepSeek content to maxChars", async () => {
    const res = await loadPage({
      url: "https://example.com/big",
      config: configWith({ deepseekFetch: "always", maxChars: 10 }),
      fetchImpl: localFetch(LONG_TEXT),
      deepseekFetchImpl: remoteFetch("T", "x".repeat(100)),
    });
    expect(res.truncated).toBe(true);
    expect(res.result).toContain("… [truncated]");
  });

  it("caches the DeepSeek-rescued result so a repeat call costs no second request", async () => {
    const cache = createCache<WebFetchResult>();
    const remote = vi.fn(remoteFetch("R", "Remote body"));
    const opts = {
      url: "https://spa.example.com/app",
      config: configWith({}),
      cache,
      fetchImpl: localFetch(THIN_TEXT),
      deepseekFetchImpl: remote as unknown as FetchImpl,
      now: () => 1000,
    };
    await loadPage(opts);
    const second = await loadPage(opts);
    expect(second.result).toBe("Remote body");
    expect(remote).toHaveBeenCalledTimes(1);
  });
});
