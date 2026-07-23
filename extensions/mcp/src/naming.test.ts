import { describe, it, expect } from "vitest";
import {
  mcpToolName,
  parseMcpToolName,
  sanitizeMcpName,
  sanitizeMcpSegment,
  sanitizeServerName,
} from "./naming.js";

// OpenAI's function-name rule: whole name must be ^[a-zA-Z][a-zA-Z0-9_-]*$.
const OPENAI_FN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

describe("mcpToolName / parseMcpToolName", () => {
  it("round-trips a simple pair", () => {
    const name = mcpToolName("github", "create_issue");
    expect(name).toBe("mcp__github__create_issue");
    expect(parseMcpToolName(name)).toEqual({ server: "github", tool: "create_issue" });
  });

  it("keeps __ inside the tool name", () => {
    const name = mcpToolName("srv", "a__b__c");
    expect(name).toBe("mcp__srv__a__b__c");
    expect(parseMcpToolName(name)).toEqual({ server: "srv", tool: "a__b__c" });
  });

  it("returns undefined for non-mcp names", () => {
    expect(parseMcpToolName("bash")).toBeUndefined();
    expect(parseMcpToolName("mcp__onlyserver")).toBeUndefined();
    expect(parseMcpToolName("mcp____tool")).toBeUndefined();
    expect(parseMcpToolName("mcp__srv__")).toBeUndefined();
  });
});

describe("sanitizeMcpSegment (tool segment, charset-only)", () => {
  it("replaces illegal chars with underscores", () => {
    expect(sanitizeMcpSegment("weird.tool name")).toBe("weird_tool_name");
    expect(sanitizeMcpSegment("a:b/c")).toBe("a_b_c");
  });

  it("preserves __ inside a tool name (does NOT collapse)", () => {
    expect(sanitizeMcpSegment("a__b__c")).toBe("a__b__c");
  });

  it("is idempotent on already-legal names", () => {
    expect(sanitizeMcpSegment("create_issue")).toBe("create_issue");
  });
});

describe("sanitizeMcpName (server segment, full normalize)", () => {
  it("turns the plugin-loader colon namespace into an underscore", () => {
    expect(sanitizeMcpName("zhiyan:zhiyan-log")).toBe("zhiyan_zhiyan-log");
  });

  it("replaces spaces / dots / slashes with underscores", () => {
    expect(sanitizeMcpName("a b.c/d")).toBe("a_b_c_d");
  });

  it("collapses runs of underscores", () => {
    expect(sanitizeMcpName("a___b")).toBe("a_b");
    expect(sanitizeMcpName("a:.:b")).toBe("a_b");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeMcpName("__ab__")).toBe("ab");
    expect(sanitizeMcpName(":foo:")).toBe("foo");
  });

  it("is idempotent on already-legal names (letters, digits, _, -)", () => {
    expect(sanitizeMcpName("zhiyan-log_2")).toBe("zhiyan-log_2");
    const once = sanitizeMcpName("a:b.c d");
    expect(sanitizeMcpName(once)).toBe(once);
  });

  it("returns empty for input that is entirely illegal", () => {
    expect(sanitizeMcpName("::")).toBe("");
    expect(sanitizeMcpName("   ")).toBe("");
  });
});

describe("sanitizeServerName", () => {
  it("sanitizes like sanitizeMcpName when there is no collision", () => {
    expect(sanitizeServerName("zhiyan:zhiyan-log")).toBe("zhiyan_zhiyan-log");
  });

  it("appends a numeric suffix on collision with a taken id", () => {
    const taken = new Set(["zhiyan_zhiyan-log"]);
    expect(sanitizeServerName("zhiyan:zhiyan-log", taken)).toBe("zhiyan_zhiyan-log_2");
    const taken2 = new Set(["zhiyan_zhiyan-log", "zhiyan_zhiyan-log_2"]);
    expect(sanitizeServerName("zhiyan.zhiyan-log", taken2)).toBe("zhiyan_zhiyan-log_3");
  });

  it("falls back to 'server' when sanitization is empty", () => {
    expect(sanitizeServerName("::")).toBe("server");
    expect(sanitizeServerName("::", new Set(["server"]))).toBe("server_2");
  });
});

describe("full tool name is always OpenAI-legal", () => {
  const cases = ["zhiyan:zhiyan-log", "a b.c/d", "::", "1numeric", "plugin:server"];
  for (const raw of cases) {
    it(`mcp__<sanitized>__<tool> matches ${OPENAI_FN} for "${raw}"`, () => {
      const server = sanitizeServerName(raw);
      const name = mcpToolName(server, sanitizeMcpSegment("query.tool name"));
      expect(name).toMatch(OPENAI_FN);
      // The mcp__ prefix guarantees a leading letter even for numeric/empty servers.
      expect(name.startsWith("mcp__")).toBe(true);
    });
  }

  it("stays parseable back to the canonical server for dispatch", () => {
    const server = sanitizeServerName("zhiyan:zhiyan-log");
    const name = mcpToolName(server, sanitizeMcpSegment("query"));
    expect(name).toBe("mcp__zhiyan_zhiyan-log__query");
    expect(parseMcpToolName(name)).toEqual({ server: "zhiyan_zhiyan-log", tool: "query" });
    // Mirrors the approvals server-level matcher (rules.ts): "mcp__<server>"
    // matches every tool via startsWith("mcp__<server>__").
    expect(name.startsWith("mcp__zhiyan_zhiyan-log__")).toBe(true);
  });
});
