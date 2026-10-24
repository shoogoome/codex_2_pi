import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadWebFetchConfig, type WebFetchConfig } from "./config.js";
import type { DeepSeekSearchResult } from "./deepseek.js";
import type { FetchImpl, FetchResponseLike } from "./fetch.js";
import { createWebFetchTool, searchCacheKey } from "./tool.js";

/* ── test doubles ─────────────────────────────────────────────────────────── */

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
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

function responseOf(body: string, contentType: string, status = 200): FetchResponseLike {
  return {
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    body: streamOf(body),
  };
}

/**
 * One fake fetch serving both pipelines: `/v1/tools/search` and
 * `/v1/tools/fetch` are DeepSeek, everything else is the page itself.
 */
function fakeFetch(handlers: {
  page?: (url: string) => FetchResponseLike;
  search?: (payload: Record<string, unknown>) => FetchResponseLike;
  deepseekFetch?: () => FetchResponseLike;
}) {
  const calls: { kind: "page" | "search" | "deepseek-fetch"; url: string; body?: string }[] = [];
  const impl: FetchImpl = async (url, init) => {
    if (url.includes("/v1/tools/search")) {
      calls.push({ kind: "search", url, body: init.body });
      return handlers.search?.(JSON.parse(init.body ?? "{}")) ?? responseOf(JSON.stringify({ results: [] }), "application/json");
    }
    if (url.includes("/v1/tools/fetch")) {
      calls.push({ kind: "deepseek-fetch", url, body: init.body });
      return handlers.deepseekFetch?.() ?? responseOf(JSON.stringify({ title: "", content: "" }), "application/json");
    }
    calls.push({ kind: "page", url });
    return handlers.page?.(url) ?? responseOf("<html><body><p>local page</p></body></html>", "text/html");
  };
  return { impl, calls };
}
function configWith(overrides: Partial<WebFetchConfig>): WebFetchConfig {
  return { ...loadWebFetchConfig({}), ...overrides };
}

/** Minimal ExtensionContext stub: only modelRegistry matters here. */
function fakeCtx(providerKey?: string): ExtensionContext {
  return {
    modelRegistry: {
      getApiKeyForProvider: vi.fn(async () => providerKey),
    },
  } as unknown as ExtensionContext;
}

/** Call the tool and return the concatenated text plus details. */
const noSleep = async () => {};

async function run(
  tool: ReturnType<typeof createWebFetchTool>,
  params: Record<string, unknown>,
  ctx: ExtensionContext = fakeCtx(),
) {
  const result = await tool.execute("call-1", params as never, undefined, undefined, ctx);
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, details: result.details };
}

/* ── search mode ──────────────────────────────────────────────────────────── */

const SEARCH_RESULTS: DeepSeekSearchResult[] = [
  {
    title: "DeepSeek Search API",
    url: "https://api-docs.deepseek.com/zh-cn/guides/search",
    summary: "Search 与 Fetch 接口按次计费。",
    snippet: "短摘要",
    site_name: "DeepSeek Docs",
    date: "2026-06-01T00:00:00+00:00",
    authority: 4,
  },
  { title: "Third party", url: "https://example.com/post", summary: "An outside write-up." },
];

describe("webfetch tool — search mode", () => {
  it("searches when given a bare phrase as url", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text, details } = await run(tool, { url: "deepseek search api pricing" });

    expect(calls.map((c) => c.kind)).toEqual(["search"]);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ query: "deepseek search api pricing" });
    expect(details.mode).toBe("search");
    expect(details.results).toBe(2);
    expect(text).toContain("Search results for: deepseek search api pricing");
    expect(text).toContain("[S1] DeepSeek Search API");
    expect(text).toContain("URL: https://api-docs.deepseek.com/zh-cn/guides/search");
    // Refs are listed so the model can reopen a result without retyping the URL.
    expect(text).toContain('S1 = https://api-docs.deepseek.com/zh-cn/guides/search');
    expect(text).toContain('"source": "S1"');
  });

  it("searches when given an explicit query, ignoring a stale url", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { url: "https://example.com/page", query: "pi agent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("search");
    expect(JSON.parse(calls[0]!.body!).query).toBe("pi agent");
  });

  it("promotes a search-engine URL to a search", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { url: "https://duckduckgo.com/?q=deepseek+v4" });
    expect(JSON.parse(calls[0]!.body!).query).toBe("deepseek v4");
  });

  it("forwards count / need_content / prompt and clamps the result listing", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text } = await run(tool, { query: "deepseek", count: 3, need_content: true, prompt: "how much does it cost" });

    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      query: "deepseek",
      count: 3,
      need_content: true,
      ori_question: "how much does it cost",
    });
    expect(text).toContain("Search intent: how much does it cost");
  });

  it("caches an identical search so a repeat costs no second billed request", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { query: "deepseek" });
    await run(tool, { query: "deepseek" });
    expect(calls.filter((c) => c.kind === "search")).toHaveLength(1);
  });

  it("falls back to the deepseek provider credentials when no env key is set", async () => {
    const { impl, calls } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: SEARCH_RESULTS }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { query: "deepseek" }, fakeCtx("sk-from-provider"));
    expect(calls[0]!.kind).toBe("search");
  });

  it("throws an actionable error when no key is available anywhere", async () => {
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: fakeFetch({}).impl, sleep: noSleep });
    await expect(run(tool, { query: "deepseek" }, fakeCtx(undefined))).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });

  it("surfaces DeepSeek errors readably", async () => {
    const { impl } = fakeFetch({
      search: () => responseOf(JSON.stringify({ error: { message: "Insufficient Balance" } }), "application/json", 402),
    });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await expect(run(tool, { query: "deepseek" })).rejects.toThrow(/余额不足.*Insufficient Balance/);
  });

  it("reports no results without pretending it was an error", async () => {
    const { impl } = fakeFetch({ search: () => responseOf(JSON.stringify({ results: [] }), "application/json") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text, details } = await run(tool, { query: "zzzzz" });
    expect(details.results).toBe(0);
    expect(text).toContain("No web results found");
  });
});

/* ── page mode ────────────────────────────────────────────────────────────── */

describe("webfetch tool — page mode", () => {
  it("fetches a URL, converts to markdown and reports a ref", async () => {
    const { impl } = fakeFetch({ page: () => responseOf("<h1>Title</h1><p>Body text</p>", "text/html") });
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text, details } = await run(tool, { url: "https://example.com/doc" });

    expect(details.mode).toBe("page");
    expect(details.via).toBe("local");
    expect(details.ref).toBe("P1");
    expect(text).toContain("# Title");
    expect(text).toContain("Body text");
    expect(text).toContain("[P1] https://example.com/doc");
  });

  it("adds the reading-intent preface", async () => {
    const { impl } = fakeFetch({});
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text } = await run(tool, { url: "https://example.com/doc", prompt: "what changed" });
    expect(text).toContain("Reading https://example.com/doc with intent: what changed");
  });

  it("reopens a known result by ref without searching again", async () => {
    const { impl, calls } = fakeFetch({
      search: () =>
        responseOf(
          JSON.stringify({ results: [{ title: "Doc", url: "https://example.com/doc", summary: "s" }] }),
          "application/json",
        ),
      page: () => responseOf("<h1>Full doc</h1><p>body</p>", "text/html"),
    });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });

    await run(tool, { query: "doc" });
    const { text, details } = await run(tool, { source: "S1" });

    expect(details.mode).toBe("page");
    expect(details.url).toBe("https://example.com/doc");
    expect(text).toContain("Full doc");
    expect(calls.filter((c) => c.kind === "search")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "page")).toHaveLength(1);
  });

  it("accepts a lowercase / bracketed ref", async () => {
    const { impl } = fakeFetch({
      search: () =>
        responseOf(JSON.stringify({ results: [{ title: "Doc", url: "https://example.com/doc" }] }), "application/json"),
      page: () => responseOf("<p>body</p>", "text/html"),
    });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { query: "doc" });
    const { details } = await run(tool, { source: "[s1]" });
    expect(details.url).toBe("https://example.com/doc");
  });

  it("explains unknown refs and lists what is known", async () => {
    const { impl } = fakeFetch({});
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    await run(tool, { url: "https://example.com/a" });
    await expect(run(tool, { source: "S99" })).rejects.toThrow(/unknown source "S99"[\s\S]*P1 → https:\/\/example.com\/a/);
  });

  it("rescues a JS-rendered page via DeepSeek Fetch (auto mode)", async () => {
    const { impl, calls } = fakeFetch({
      page: () => responseOf("<html><body><div id='root'></div></body></html>", "text/html"),
      deepseekFetch: () => responseOf(JSON.stringify({ title: "Rendered", content: "# Rendered\n\nReal content." }), "application/json"),
    });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { text, details } = await run(tool, { url: "https://spa.example.com/app" });

    expect(details.via).toBe("deepseek");
    expect(details.title).toBe("Rendered");
    expect(text).toContain("# Rendered");
    expect(text).toContain("Real content.");
    expect(text).toContain("Extracted with DeepSeek Fetch");
    expect(calls.filter((c) => c.kind === "deepseek-fetch")).toHaveLength(1);
  });

  it("does not call DeepSeek Fetch for a rich local page", async () => {
    const rich = `<p>${"plenty of prose. ".repeat(50)}</p>`;
    const { impl, calls } = fakeFetch({ page: () => responseOf(rich, "text/html") });
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "sk-test" }), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { details } = await run(tool, { url: "https://example.com/doc" });
    expect(details.via).toBe("local");
    expect(calls.some((c) => c.kind === "deepseek-fetch")).toBe(false);
  });

  it("keeps page mode working when no API key is configured", async () => {
    const { impl } = fakeFetch({ page: () => responseOf("<h1>T</h1><p>b</p>", "text/html") });
    const tool = createWebFetchTool({ config: configWith({}), fetchImpl: impl, searchFetchImpl: impl, deepseekFetchImpl: impl, sleep: noSleep });
    const { details } = await run(tool, { url: "https://example.com/doc" }, fakeCtx(undefined));
    expect(details.mode).toBe("page");
  });

  it("throws for an empty call", async () => {
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "k" }), fetchImpl: fakeFetch({}).impl, sleep: noSleep });
    await expect(run(tool, {})).rejects.toThrow(/需要 url/);
  });
});

/* ── metadata ─────────────────────────────────────────────────────────────── */

describe("webfetch tool — metadata", () => {
  it("keeps a search-capable prompt when a key is configured", () => {
    const tool = createWebFetchTool({ config: configWith({ deepseekApiKey: "k" }) });
    expect(tool.description).toContain("Search: pass `query`");
    expect(tool.description).not.toContain("DISABLED");
    expect(tool.promptSnippet).toContain("search the web");
    expect(tool.promptGuidelines?.join(" ")).toContain("Cite web sources");
  });

  it("advertises search as disabled when no key is configured", () => {
    const tool = createWebFetchTool({ config: configWith({}) });
    expect(tool.description).toContain("DISABLED");
    expect(tool.description).toContain("DEEPSEEK_API_KEY");
  });

  it("is read-only, parallel-safe and self-rendering", () => {
    const tool = createWebFetchTool({ config: configWith({}) });
    expect(tool.executionMode).toBe("parallel");
    expect(tool.renderShell).toBe("self");
    expect(tool.name).toBe("webfetch");
  });
});

describe("searchCacheKey", () => {
  it("distinguishes count and need_content but not prompt", () => {
    expect(searchCacheKey("q", 8, false)).toBe("search:8:0:q");
    expect(searchCacheKey("q", 8, true)).not.toBe(searchCacheKey("q", 8, false));
    expect(searchCacheKey("q", 9, false)).not.toBe(searchCacheKey("q", 8, false));
  });
});
