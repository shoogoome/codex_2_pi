import { describe, expect, it, vi } from "vitest";
import type { FetchImpl, FetchResponseLike } from "./fetch.js";
import {
  DeepSeekApiError,
  clampText,
  describeStatus,
  fetchPageViaDeepSeek,
  formatSearchResults,
  normalizeQuery,
  resultLabel,
  searchWeb,
  shortDate,
  tidyMarkdown,
  toolEndpoint,
} from "./deepseek.js";

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

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    status,
    headers: { get: () => "application/json" },
    body: streamOf(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Records every request so tests can assert URL / headers / payload. */
function recordingFetch(response: FetchResponseLike | (() => FetchResponseLike)) {
  const calls: { url: string; init: Parameters<FetchImpl>[1] }[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { impl, calls };
}

const noSleep = async () => {};

describe("normalizeQuery", () => {
  it("trims, collapses whitespace and clamps to 128 chars", () => {
    expect(normalizeQuery("  deepseek   v4  ")).toBe("deepseek v4");
    const long = "x".repeat(200);
    expect(normalizeQuery(long)).toHaveLength(128);
  });
});

describe("toolEndpoint", () => {
  it("joins the base URL without doubling slashes", () => {
    expect(toolEndpoint("https://api.deepseek.com", "search")).toBe("https://api.deepseek.com/v1/tools/search");
    expect(toolEndpoint("https://api.deepseek.com/", "fetch")).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(toolEndpoint("https://proxy.example/v1///", "search")).toBe("https://proxy.example/v1/v1/tools/search");
  });
});

describe("describeStatus", () => {
  it("maps the documented codes to readable reasons", () => {
    expect(describeStatus(401)).toContain("API Key");
    expect(describeStatus(402)).toContain("余额");
    expect(describeStatus(403)).toContain("安全策略");
    expect(describeStatus(404)).toContain("未能获取");
    expect(describeStatus(429)).toContain("QPS");
    expect(describeStatus(504)).toContain("超时");
    expect(describeStatus(418)).toContain("418");
  });
});

describe("searchWeb", () => {
  it("POSTs the documented payload with Bearer auth", async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ results: [{ title: "t", url: "https://e.com" }] }));
    const results = await searchWeb({
      query: "deepseek 搜索",
      count: 5,
      needContent: true,
      oriQuestion: "deepseek 有搜索 api 吗",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer sk-test");
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(calls[0]!.init.body!);
    expect(payload).toEqual({
      query: "deepseek 搜索",
      count: 5,
      need_content: true,
      ori_question: "deepseek 有搜索 api 吗",
    });
  });

  it("clamps an out-of-range count instead of sending an invalid request", async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ results: [] }));
    await searchWeb({ query: "q", count: 500, apiKey: "k", fetchImpl: impl, sleep: noSleep });
    expect(JSON.parse(calls[0]!.init.body!).count).toBe(50);
  });

  it("omits optional fields that were not provided", async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ results: [] }));
    await searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep });
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ query: "q" });
  });

  it("returns [] when the API omits results (empty search is not an error)", async () => {
    const { impl } = recordingFetch(jsonResponse({}));
    await expect(searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep })).resolves.toEqual([]);
  });

  it("throws a readable error when no API key is configured", async () => {
    await expect(searchWeb({ query: "q", fetchImpl: async () => jsonResponse({}) })).rejects.toThrow(/API Key/);
  });

  it("throws on an empty query without calling the network", async () => {
    const impl = vi.fn();
    await expect(
      searchWeb({ query: "   ", apiKey: "k", fetchImpl: impl as unknown as FetchImpl }),
    ).rejects.toThrow(/搜索词不能为空/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("maps an error body to a status + detail message", async () => {
    const { impl } = recordingFetch(
      jsonResponse({ error: { message: "'count' must be between 1 and 50", type: "invalid_request_error" } }, 400),
    );
    await expect(
      searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep }),
    ).rejects.toThrow(/'count' must be between 1 and 50/);
  });

  it("retries 429/5xx then surfaces the final error", async () => {
    let calls = 0;
    const impl: FetchImpl = async () => {
      calls++;
      return jsonResponse({ error: { message: "rate limited" } }, 429);
    };
    await expect(
      searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep, retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 } }),
    ).rejects.toThrow(/QPS/);
    expect(calls).toBe(3); // attempts: 3
  });

  it("does not retry a non-retryable 400", async () => {
    let calls = 0;
    const impl: FetchImpl = async () => {
      calls++;
      return jsonResponse({ error: { message: "bad" } }, 400);
    };
    await expect(
      searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep, retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 } }),
    ).rejects.toThrow(/bad/);
    expect(calls).toBe(1);
  });

  it("reports a non-JSON 200 body as an error", async () => {
    const { impl } = recordingFetch(jsonResponse("<html>login</html>"));
    await expect(searchWeb({ query: "q", apiKey: "k", fetchImpl: impl, sleep: noSleep })).rejects.toBeInstanceOf(
      DeepSeekApiError,
    );
  });
});

describe("fetchPageViaDeepSeek", () => {
  it("posts the url and returns title + markdown content", async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ title: "Example", content: "# Example\n\nbody" }));
    const page = await fetchPageViaDeepSeek({ url: "https://example.com/a", apiKey: "k", fetchImpl: impl, sleep: noSleep });
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ url: "https://example.com/a" });
    expect(page).toEqual({ title: "Example", content: "# Example\n\nbody" });
  });

  it("defaults missing fields to empty strings", async () => {
    const { impl } = recordingFetch(jsonResponse({}));
    await expect(fetchPageViaDeepSeek({ url: "https://e.com", apiKey: "k", fetchImpl: impl, sleep: noSleep })).resolves.toEqual({
      title: "",
      content: "",
    });
  });
});

describe("shortDate / tidyMarkdown / clampText", () => {
  it("shortens RFC 3339 dates to the date part", () => {
    expect(shortDate("2026-06-01T00:00:00+00:00")).toBe("2026-06-01");
    expect(shortDate(null)).toBe("");
    expect(shortDate("2026")).toBe("2026");
  });

  it("tidies markdown without touching its structure", () => {
    expect(tidyMarkdown("a  \r\n\r\n\r\n\r\nb  ")).toBe("a\n\nb");
  });

  it("clamps text and marks truncation", () => {
    expect(clampText("abcdef", 3)).toEqual({ text: "abc\n\n… [truncated]", truncated: true });
    expect(clampText("abc", 10)).toEqual({ text: "abc", truncated: false });
  });
});

describe("formatSearchResults", () => {
  const results = [
    {
      title: "DeepSeek V4 发布",
      url: "https://example.com/v4",
      summary: "DeepSeek 发布了 V4，改进了工具调用。",
      snippet: "short",
      site_name: "Example News",
      date: "2026-06-01T00:00:00+00:00",
      authority: 3,
      content: "# V4\n\nbody text",
    },
    { title: "", url: "", snippet: "only a snippet" },
  ];

  it("labels each result and includes title, url, date and summary", () => {
    const out = formatSearchResults(results, { queryLabel: "deepseek v4" });
    expect(out).toContain("Search results for: deepseek v4");
    expect(out).toContain("[S1] DeepSeek V4 发布 (Example News, 2026-06-01, authoritative)");
    expect(out).toContain("URL: https://example.com/v4");
    expect(out).toContain("DeepSeek 发布了 V4，改进了工具调用。");
    // Falls back to the snippet and flags the missing URL.
    expect(out).toContain("[S2] (untitled)");
    expect(out).toContain("URL: (missing)");
    expect(out).toContain("only a snippet");
  });

  it("omits content unless asked for, and clamps it when asked", () => {
    expect(formatSearchResults(results, { queryLabel: "q" })).not.toContain("Content:");
    const withContent = formatSearchResults(results, { queryLabel: "q", includeContent: true, contentChars: 4 });
    expect(withContent).toContain("Content:");
    expect(withContent).toContain("… [truncated]");
  });

  it("tells the model how to cite and that refs are internal", () => {
    const out = formatSearchResults(results, { queryLabel: "q" });
    expect(out).toContain("Markdown link");
    expect(out).toContain("[S1] are for follow-up calls only");
  });

  it("returns a helpful message for an empty result set", () => {
    expect(formatSearchResults([], { queryLabel: "nothing" })).toContain("No web results found");
  });

  it("caps the whole listing at maxChars", () => {
    const out = formatSearchResults(results, { queryLabel: "q", maxChars: 120 });
    expect(out.length).toBeLessThan(400); // clamp + footer
    expect(out).toContain("… [truncated]");
  });
});

describe("resultLabel", () => {
  it("is 1-based and stable", () => {
    expect(resultLabel(0)).toBe("S1");
    expect(resultLabel(9)).toBe("S10");
  });
});
