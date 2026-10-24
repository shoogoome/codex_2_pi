import { describe, expect, it } from "vitest";
import { planRequest, queryFromSearchUrl } from "./intent.js";

describe("queryFromSearchUrl", () => {
  it("extracts the query from common search-engine URLs", () => {
    expect(queryFromSearchUrl("https://duckduckgo.com/?q=deepseek+search")).toBe("deepseek search");
    expect(queryFromSearchUrl("https://www.google.com/search?q=pi+agent")).toBe("pi agent");
    expect(queryFromSearchUrl("https://cn.bing.com/search?q=%E4%B8%AD%E6%96%87")).toBe("中文");
    expect(queryFromSearchUrl("https://www.baidu.com/s?wd=%E6%90%9C%E7%B4%A2")).toBe("搜索");
    expect(queryFromSearchUrl("http://search.brave.com/search?q=rust")).toBe("rust");
  });

  it("returns null for non-search-engine URLs", () => {
    expect(queryFromSearchUrl("https://example.com/?q=this+is+a+page")).toBeNull();
    expect(queryFromSearchUrl("https://docs.deepseek.com/zh-cn/guides/search")).toBeNull();
    expect(queryFromSearchUrl("not a url")).toBeNull();
  });

  it("returns null when the engine URL carries no query parameter", () => {
    expect(queryFromSearchUrl("https://duckduckgo.com/")).toBeNull();
    expect(queryFromSearchUrl("https://www.google.com/search?q=")).toBeNull();
  });

  it("does not mistake an unrelated host that merely ends in the engine name", () => {
    expect(queryFromSearchUrl("https://notgoogle.com/search?q=x")).toBeNull();
  });
});

describe("planRequest", () => {
  it("treats a real URL as page mode", () => {
    expect(planRequest({ url: "https://example.com/docs" })).toEqual({
      mode: "page",
      url: "https://example.com/docs",
    });
  });

  it("promotes a search-engine URL to search mode", () => {
    expect(planRequest({ url: "https://duckduckgo.com/?q=deepseek+v4" })).toEqual({
      mode: "search",
      query: "deepseek v4",
    });
  });

  it("treats a bare phrase as a search query", () => {
    expect(planRequest({ url: "deepseek search api pricing" })).toEqual({
      mode: "search",
      query: "deepseek search api pricing",
    });
  });

  it("treats a bare host without a scheme as page mode", () => {
    expect(planRequest({ url: "example.com/docs" })).toEqual({ mode: "page", url: "https://example.com/docs" });
    expect(planRequest({ url: "localhost:3000/api" })).toEqual({ mode: "page", url: "https://localhost:3000/api" });
  });

  it("lets an explicit query win over url", () => {
    expect(planRequest({ url: "https://example.com", query: "pi agent" })).toEqual({ mode: "search", query: "pi agent" });
  });

  it("strips wrapping quotes from the query", () => {
    expect(planRequest({ query: '"exact phrase"' })).toEqual({ mode: "search", query: "exact phrase" });
  });

  it("errors when neither url nor query is given", () => {
    const plan = planRequest({});
    expect(plan.mode).toBe("error");
  });

  it("errors on an over-long query instead of silently truncating the user's intent", () => {
    const plan = planRequest({ query: "x".repeat(200) });
    expect(plan.mode).toBe("error");
  });

  it("keeps a scheme'd URL in page mode even if the host looks odd, so typos fail loudly", () => {
    expect(planRequest({ url: "https://exa mple.com" })).toEqual({ mode: "page", url: "https://exa mple.com" });
  });
});
