import { describe, expect, it, vi } from "vitest";
import { loadWebFetchConfig, type WebFetchConfig } from "./config.js";
import { createCache } from "./cache.js";
import {
  fetchAndExtract,
  isBinaryContentType,
  type FetchImpl,
  type FetchResponseLike,
} from "./fetch.js";

/** A ReadableStream that yields the given byte chunks then closes. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  chunks?: Uint8Array[];
}

/** Build a minimal fetch-Response-like object (case-insensitive header lookup). */
function makeResponse(spec: ResponseSpec): FetchResponseLike {
  const map = new Map(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const chunks = spec.chunks ?? [new TextEncoder().encode(spec.text ?? "")];
  return {
    status: spec.status ?? 200,
    headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
    body: streamOf(chunks),
  };
}

/** A fetch impl that returns queued/mapped responses and records requested URLs. */
function fakeFetch(handler: (url: string) => ResponseSpec): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl: FetchImpl = async (url) => {
    urls.push(url);
    return makeResponse(handler(url));
  };
  return { impl, urls };
}

const baseConfig: WebFetchConfig = loadWebFetchConfig({});

describe("isBinaryContentType", () => {
  it("treats text/JSON/xml/js as textual", () => {
    expect(isBinaryContentType("text/html; charset=utf-8")).toBe(false);
    expect(isBinaryContentType("application/json")).toBe(false);
    expect(isBinaryContentType("application/xml")).toBe(false);
    expect(isBinaryContentType("application/javascript")).toBe(false);
    expect(isBinaryContentType("application/vnd.api+json")).toBe(false);
    expect(isBinaryContentType("")).toBe(false);
  });

  it("treats media, fonts and known binary application types as binary", () => {
    expect(isBinaryContentType("image/png")).toBe(true);
    expect(isBinaryContentType("audio/mpeg")).toBe(true);
    expect(isBinaryContentType("video/mp4")).toBe(true);
    expect(isBinaryContentType("font/woff2")).toBe(true);
    expect(isBinaryContentType("application/pdf")).toBe(true);
    expect(isBinaryContentType("application/octet-stream")).toBe(true);
  });
});

describe("fetchAndExtract — content handling", () => {
  it("converts text/html to markdown and upgrades http→https", async () => {
    const { impl, urls } = fakeFetch(() => ({
      headers: { "content-type": "text/html" },
      text: "<h1>Title</h1><p>Body text</p>",
    }));
    const res = await fetchAndExtract("http://example.com/", { config: baseConfig, fetchImpl: impl });
    expect(urls).toEqual(["https://example.com/"]); // http upgraded before the request
    expect(res.code).toBe(200);
    expect(res.result).toContain("# Title");
    expect(res.result).toContain("Body text");
    expect(res.redirected).toBe(false);
    expect(res.bytes).toBeGreaterThan(0);
  });

  it("returns JSON / plain text verbatim (no HTML conversion)", async () => {
    const { impl } = fakeFetch(() => ({
      headers: { "content-type": "application/json" },
      text: '{"a":1,"b":"<x>"}',
    }));
    const res = await fetchAndExtract("https://api.example.com/data", { config: baseConfig, fetchImpl: impl });
    expect(res.result).toBe('{"a":1,"b":"<x>"}');
    expect(res.contentType).toBe("application/json");
  });

  it("does not fetch binary bodies — returns a placeholder", async () => {
    const { impl } = fakeFetch(() => ({
      headers: { "content-type": "application/pdf" },
      chunks: [new Uint8Array([0x25, 0x50, 0x44, 0x46])], // %PDF
    }));
    const res = await fetchAndExtract("https://example.com/x.pdf", { config: baseConfig, fetchImpl: impl });
    expect(res.result).toBe("[Binary content (application/pdf, 4 bytes) not fetched]");
  });
});

describe("fetchAndExtract — size and char caps", () => {
  it("caps the body at maxBytes (streamed, never fully buffered)", async () => {
    const big = new Uint8Array(100).fill(0x61); // 100 * "a"
    const { impl } = fakeFetch(() => ({ headers: { "content-type": "text/plain" }, chunks: [big] }));
    const config: WebFetchConfig = { ...baseConfig, maxBytes: 10 };
    const res = await fetchAndExtract("https://example.com/big", { config, fetchImpl: impl });
    expect(res.bytes).toBe(10);
    expect(res.truncated).toBe(true);
    expect(res.result).toBe("aaaaaaaaaa");
  });

  it("caps extracted text at maxChars with a truncation marker", async () => {
    const { impl } = fakeFetch(() => ({ headers: { "content-type": "text/plain" }, text: "abcdefghij" }));
    const config: WebFetchConfig = { ...baseConfig, maxChars: 5 };
    const res = await fetchAndExtract("https://example.com/txt", { config, fetchImpl: impl });
    expect(res.result).toBe("abcde\n\n… [truncated]");
    expect(res.truncated).toBe(true);
  });
});

describe("fetchAndExtract — redirect policy", () => {
  it("follows a same-host redirect automatically", async () => {
    const impl: FetchImpl = async (url) => {
      if (url === "https://example.com/a") {
        return makeResponse({ status: 301, headers: { location: "https://example.com/b" } });
      }
      return makeResponse({ headers: { "content-type": "text/plain" }, text: "final" });
    };
    const res = await fetchAndExtract("https://example.com/a", { config: baseConfig, fetchImpl: impl });
    expect(res.code).toBe(200);
    expect(res.result).toBe("final");
    expect(res.redirected).toBe(true);
  });

  it("does NOT follow a cross-host redirect — surfaces a REDIRECT DETECTED notice", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 302, headers: { location: "https://evil.com/" } }));
    const res = await fetchAndExtract("https://example.com/", { config: baseConfig, fetchImpl: impl });
    expect(res.code).toBe(302);
    expect(res.result).toContain("REDIRECT DETECTED: https://evil.com/");
    expect(res.redirected).toBe(true);
    expect(urls).toHaveLength(1); // never chased the cross-host hop
  });

  it("throws after exceeding the max same-host redirect hops", async () => {
    const { impl } = fakeFetch(() => ({ status: 301, headers: { location: "/loop" } }));
    await expect(
      fetchAndExtract("https://example.com/start", { config: baseConfig, fetchImpl: impl }),
    ).rejects.toThrow(/too many redirects/i);
  });

  it("throws when a redirect has no Location header", async () => {
    const { impl } = fakeFetch(() => ({ status: 301 }));
    await expect(
      fetchAndExtract("https://example.com/", { config: baseConfig, fetchImpl: impl }),
    ).rejects.toThrow(/missing Location/i);
  });
});

describe("fetchAndExtract — DNS SSRF guard (resolved-IP validation)", () => {
  it("blocks a public hostname that RESOLVES to an internal address, before any fetch", async () => {
    const impl = vi.fn(async () => makeResponse({ headers: { "content-type": "text/plain" }, text: "secret" }));
    await expect(
      fetchAndExtract("https://metadata.attacker.com/latest/meta-data/", {
        config: baseConfig,
        fetchImpl: impl as unknown as FetchImpl,
        resolveHost: async () => ["169.254.169.254"], // A record → cloud metadata
      }),
    ).rejects.toThrow(/internal\/private address/i);
    expect(impl).not.toHaveBeenCalled(); // guard fires before the request
  });

  it("blocks when ANY resolved address is private (mixed public+private answer)", async () => {
    const impl = vi.fn();
    await expect(
      fetchAndExtract("https://rebind.example.com/", {
        config: baseConfig,
        fetchImpl: impl as unknown as FetchImpl,
        resolveHost: async () => ["93.184.216.34", "10.0.0.5"],
      }),
    ).rejects.toThrow(/internal\/private address/i);
    expect(impl).not.toHaveBeenCalled();
  });

  it("proceeds normally when the host resolves to a public address", async () => {
    const { impl } = fakeFetch(() => ({ headers: { "content-type": "text/plain" }, text: "ok" }));
    const res = await fetchAndExtract("https://example.com/", {
      config: baseConfig,
      fetchImpl: impl,
      resolveHost: async () => ["93.184.216.34"],
    });
    expect(res.result).toBe("ok");
  });

  it("re-checks resolution on each redirect hop (rebinding-on-redirect is refused)", async () => {
    let calls = 0;
    const resolveHost = async () => (++calls === 1 ? ["93.184.216.34"] : ["10.0.0.5"]);
    const impl: FetchImpl = async (url) => {
      if (url === "https://example.com/a") {
        return makeResponse({ status: 301, headers: { location: "https://example.com/b" } });
      }
      return makeResponse({ headers: { "content-type": "text/plain" }, text: "final" });
    };
    await expect(
      fetchAndExtract("https://example.com/a", { config: baseConfig, fetchImpl: impl, resolveHost }),
    ).rejects.toThrow(/internal\/private address/i);
  });

  it("fails closed when resolution errors or returns nothing", async () => {
    const impl = vi.fn();
    await expect(
      fetchAndExtract("https://broken.example.com/", {
        config: baseConfig,
        fetchImpl: impl as unknown as FetchImpl,
        resolveHost: async () => {
          throw new Error("SERVFAIL");
        },
      }),
    ).rejects.toThrow(/could not resolve/i);
    await expect(
      fetchAndExtract("https://empty.example.com/", {
        config: baseConfig,
        fetchImpl: impl as unknown as FetchImpl,
        resolveHost: async () => [],
      }),
    ).rejects.toThrow(/did not resolve/i);
    expect(impl).not.toHaveBeenCalled();
  });

  it("skips DNS resolution for IP literals (already range-checked by checkUrl)", async () => {
    const resolveHost = vi.fn(async () => {
      throw new Error("resolver must not be called for an IP literal");
    });
    const { impl } = fakeFetch(() => ({ headers: { "content-type": "text/plain" }, text: "lit" }));
    const res = await fetchAndExtract("https://8.8.8.8/", { config: baseConfig, fetchImpl: impl, resolveHost });
    expect(res.result).toBe("lit");
    expect(resolveHost).not.toHaveBeenCalled();
  });
});

describe("fetchAndExtract — validation and caching", () => {  it("throws for a blocked internal host before any request", async () => {
    const impl = vi.fn();
    await expect(
      fetchAndExtract("https://localhost/", { config: baseConfig, fetchImpl: impl as unknown as FetchImpl }),
    ).rejects.toThrow(/webfetch:/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("serves a repeat request from cache without a second fetch", async () => {
    const impl = vi.fn(async () => makeResponse({ headers: { "content-type": "text/plain" }, text: "cached" }));
    const cache = createCache<Awaited<ReturnType<typeof fetchAndExtract>>>();
    const opts = { config: baseConfig, cache, fetchImpl: impl as unknown as FetchImpl, now: () => 1000 };

    const first = await fetchAndExtract("https://example.com/c", opts);
    const second = await fetchAndExtract("https://example.com/c", opts);
    expect(first.result).toBe("cached");
    expect(second.result).toBe("cached");
    expect(impl).toHaveBeenCalledTimes(1); // second call hit the cache
  });

  it("re-fetches once the cache entry has expired", async () => {
    const impl = vi.fn(async () => makeResponse({ headers: { "content-type": "text/plain" }, text: "v" }));
    const cache = createCache<Awaited<ReturnType<typeof fetchAndExtract>>>();
    const config: WebFetchConfig = { ...baseConfig, cacheMs: 1000 };
    await fetchAndExtract("https://example.com/e", { config, cache, fetchImpl: impl as unknown as FetchImpl, now: () => 0 });
    // now - ts = 2000 > cacheMs 1000 → expired, must fetch again
    await fetchAndExtract("https://example.com/e", { config, cache, fetchImpl: impl as unknown as FetchImpl, now: () => 2000 });
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
