import { describe, it, expect } from "vitest";
import {
  parseMcpConfig,
  mergeMcpConfigs,
  computeConfigPaths,
  normalizeServerConfig,
  withRuntimeServer,
  applyServerToConfigText,
  removeServerFromConfigText,
} from "./config.js";
import type { McpStdioConfig, McpHttpConfig } from "./types.js";

describe("parseMcpConfig", () => {
  it("returns empty + error on invalid JSON", () => {
    const { servers, errors } = parseMcpConfig("{not json");
    expect(servers).toEqual({});
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("invalid JSON");
  });

  it("degrades safely when mcpServers section is missing", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({ other: 1 }));
    expect(servers).toEqual({});
    expect(errors).toEqual([]);
  });

  it("returns empty for empty text without error", () => {
    expect(parseMcpConfig("")).toEqual({ servers: {}, errors: [] });
    expect(parseMcpConfig("   \n ")).toEqual({ servers: {}, errors: [] });
  });

  it("classifies a stdio server", () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: "node", args: ["server.js"], env: { FOO: "bar" } },
        },
      }),
    );
    expect(errors).toEqual([]);
    const cfg = servers.fs as McpStdioConfig;
    expect(cfg.command).toBe("node");
    expect(cfg.args).toEqual(["server.js"]);
    expect(cfg.env).toEqual({ FOO: "bar" });
  });

  it("classifies an http server and defaults type", () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://x.example/mcp", headers: { Authorization: "t" } },
          streamed: { type: "sse", url: "https://y.example/sse" },
        },
      }),
    );
    const http = servers.remote as McpHttpConfig;
    expect(http.type).toBe("http");
    expect(http.url).toBe("https://x.example/mcp");
    expect(http.headers).toEqual({ Authorization: "t" });
    expect((servers.streamed as McpHttpConfig).type).toBe("sse");
  });

  it("records an error for entries missing command and url", () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({ mcpServers: { broken: { foo: 1 } } }),
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("broken");
  });

  it("flags mcpServers that is not an object", () => {
    const { errors } = parseMcpConfig(JSON.stringify({ mcpServers: 5 }));
    expect(errors[0]).toContain("mcpServers is not an object");
  });
});

describe("normalizeServerConfig", () => {
  it("drops non-string args and env values", () => {
    const cfg = normalizeServerConfig({
      command: "run",
      args: ["a", 2, "b"],
      env: { OK: "1", BAD: 3 },
    }) as McpStdioConfig;
    expect(cfg.args).toEqual(["a", "b"]);
    expect(cfg.env).toEqual({ OK: "1" });
  });

  it("returns undefined for garbage", () => {
    expect(normalizeServerConfig(null)).toBeUndefined();
    expect(normalizeServerConfig("x")).toBeUndefined();
    expect(normalizeServerConfig({})).toBeUndefined();
  });
});

describe("mergeMcpConfigs", () => {
  it("project wins on name conflict and tags source", () => {
    const merged = mergeMcpConfigs(
      { a: { command: "g" }, shared: { command: "global-cmd" } },
      { b: { command: "p" }, shared: { command: "project-cmd" } },
    );
    expect(Object.keys(merged).sort()).toEqual(["a", "b", "shared"]);
    expect(merged.a.source).toBe("global");
    expect(merged.b.source).toBe("project");
    expect(merged.shared.source).toBe("project");
    expect((merged.shared.config as McpStdioConfig).command).toBe("project-cmd");
  });
});

describe("withRuntimeServer", () => {
  it("adds a runtime server without mutating input", () => {
    const base = mergeMcpConfigs({ a: { command: "g" } }, {});
    const next = withRuntimeServer(base, "rt", { command: "r" });
    expect(base.rt).toBeUndefined();
    expect(next.rt.source).toBe("runtime");
  });
});

describe("computeConfigPaths", () => {
  it("builds canonical and compatible legacy paths", () => {
    const paths = computeConfigPaths("/home/u", "/proj");
    expect(paths.globalPath).toBe("/home/u/.pi/agent/mcp.json");
    expect(paths.projectPath).toBe("/proj/.pi/mcp.json");
    expect(paths.legacyGlobalPath).toBe("/home/u/.pi/agent/.mcp.json");
    expect(paths.legacyProjectPath).toBe("/proj/.mcp.json");
  });
});

describe("applyServerToConfigText / removeServerFromConfigText", () => {
  it("adds a server to empty/absent text", () => {
    const out = applyServerToConfigText("", "fs", { command: "node" });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.fs).toEqual({ command: "node" });
  });

  it("preserves existing servers and other top-level keys", () => {
    const start = JSON.stringify({ other: 1, mcpServers: { a: { command: "x" } } });
    const out = applyServerToConfigText(start, "b", { type: "http", url: "u" });
    const parsed = JSON.parse(out);
    expect(parsed.other).toBe(1);
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["a", "b"]);
  });

  it("recovers from malformed text by starting fresh", () => {
    const out = applyServerToConfigText("{bad", "a", { command: "c" });
    expect(JSON.parse(out).mcpServers.a).toEqual({ command: "c" });
  });

  it("removes a server", () => {
    const start = JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    const out = removeServerFromConfigText(start, "a");
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.a).toBeUndefined();
    expect(parsed.mcpServers.b).toBeDefined();
  });
});
