import { describe, it, expect } from "vitest";
import {
  normalizeServersObject,
  mergeServers,
  buildMcpRegistrations,
  detectMcpExtension,
  MCP_REGISTER_CHANNEL,
} from "./mcp.js";

describe("normalizeServersObject", () => {
  it("unwraps a { mcpServers } wrapper", () => {
    const out = normalizeServersObject({ mcpServers: { db: { command: "run" } } });
    expect(out).toEqual({ db: { command: "run" } });
  });

  it("accepts a bare record of configs", () => {
    const out = normalizeServersObject({ web: { url: "u" } });
    expect(out).toEqual({ web: { url: "u" } });
  });

  it("drops non-object server values", () => {
    const out = normalizeServersObject({ good: { url: "u" }, bad: "x", also: 3 });
    expect(out).toEqual({ good: { url: "u" } });
  });

  it("returns empty for arrays / null / non-objects", () => {
    expect(normalizeServersObject([1, 2])).toEqual({});
    expect(normalizeServersObject(null)).toEqual({});
    expect(normalizeServersObject("str")).toEqual({});
  });
});

describe("mergeServers", () => {
  it("merges with later records overriding earlier", () => {
    const merged = mergeServers({ a: { v: 1 }, b: { v: 1 } }, { b: { v: 2 }, c: { v: 3 } });
    expect(merged).toEqual({ a: { v: 1 }, b: { v: 2 }, c: { v: 3 } });
  });
});

describe("buildMcpRegistrations", () => {
  it("namespaces names and substitutes CLAUDE_PLUGIN_ROOT deeply", () => {
    const regs = buildMcpRegistrations(
      "demo",
      {
        local: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
          args: ["--data", "${CLAUDE_PLUGIN_ROOT}/data"],
          env: { TOKEN: "static" },
        },
        remote: { url: "https://x", headers: { Root: "$CLAUDE_PLUGIN_ROOT" } },
      },
      "/plug/demo",
    );
    const byName = Object.fromEntries(regs.map((r) => [r.name, r.config]));
    expect(byName["demo:local"]).toEqual({
      command: "/plug/demo/bin/server",
      args: ["--data", "/plug/demo/data"],
      env: { TOKEN: "static" },
    });
    expect(byName["demo:remote"]).toEqual({
      url: "https://x",
      headers: { Root: "/plug/demo" },
    });
  });

  it("returns [] for no servers", () => {
    expect(buildMcpRegistrations("p", {}, "/r")).toEqual([]);
  });
});

describe("detectMcpExtension", () => {
  it("true when an mcp command is present", () => {
    expect(detectMcpExtension([{ name: "diff" }, { name: "mcp" }])).toBe(true);
  });

  it("false otherwise", () => {
    expect(detectMcpExtension([{ name: "diff" }])).toBe(false);
    expect(detectMcpExtension([])).toBe(false);
  });
});

describe("MCP_REGISTER_CHANNEL", () => {
  it("is the agreed channel name", () => {
    expect(MCP_REGISTER_CHANNEL).toBe("mcp:register-server");
  });
});
