import { describe, it, expect } from "vitest";
import {
  normalizeServersObject,
  mergeServers,
  buildMcpRegistrations,
  reconcileMcpRegistrations,
  sanitizeServerName,
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

  it("drops non-object and array server values", () => {
    const out = normalizeServersObject({
      good: { url: "u" },
      bad: "x",
      also: 3,
      array: ["not", "a", "config"],
    });
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
  it("namespaces names with '_' (never ':') and substitutes CLAUDE_PLUGIN_ROOT deeply", () => {
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
    expect(byName["demo_local"]).toEqual({
      command: "/plug/demo/bin/server",
      args: ["--data", "/plug/demo/data"],
      env: { TOKEN: "static" },
      exposure: "codemode",
    });
    expect(byName["demo_remote"]).toEqual({
      url: "https://x",
      headers: { Root: "/plug/demo" },
      exposure: "codemode",
    });
    // No generated name may contain a colon (the original 400-causing bug).
    for (const r of regs) expect(r.name).not.toContain(":");
  });

  it("sanitizes illegal chars in plugin/server names to an OpenAI-legal id", () => {
    const regs = buildMcpRegistrations(
      "zhiyan",
      { "zhiyan-log": { url: "https://x" }, "weird name.v2": { url: "https://y" } },
      "/r",
    );
    const names = regs.map((r) => r.name);
    expect(names).toEqual(["zhiyan_zhiyan-log", "zhiyan_weird_name_v2"]);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });

  it("preserves explicit exposure overrides", () => {
    const [registration] = buildMcpRegistrations(
      "p",
      { server: { command: "run", exposure: "deferred" } },
      "/r",
    );
    expect(registration?.config).toEqual({ command: "run", exposure: "deferred" });
  });

  it("returns [] for no servers", () => {
    expect(buildMcpRegistrations("p", {}, "/r")).toEqual([]);
  });
});

describe("sanitizeServerName", () => {
  it("replaces colons and collapses/strips underscores", () => {
    expect(sanitizeServerName("zhiyan:zhiyan-log")).toBe("zhiyan_zhiyan-log");
    expect(sanitizeServerName("a b.c/d")).toBe("a_b_c_d");
    expect(sanitizeServerName("__x__")).toBe("x");
  });
});

describe("reconcileMcpRegistrations", () => {
  it("unregisters removed servers and registers the desired set through Pi 1.0", () => {
    const calls: string[] = [];
    const registrar = {
      registerMcpServer(name: string): void {
        calls.push(`register:${name}`);
      },
      unregisterMcpServer(name: string): void {
        calls.push(`unregister:${name}`);
      },
    };

    const result = reconcileMcpRegistrations(
      registrar,
      new Set(["removed", "kept"]),
      [
        { name: "kept", config: { command: "new-command" } },
        { name: "added", config: { url: "https://example.com/mcp" } },
      ],
    );

    expect(calls).toEqual([
      "unregister:removed",
      "register:kept",
      "register:added",
    ]);
    expect([...result.registeredNames]).toEqual(["kept", "added"]);
    expect(result.errors).toEqual([]);
  });

  it("isolates invalid registrations and removes a stale previous registration", () => {
    const calls: string[] = [];
    const registrar = {
      registerMcpServer(name: string): void {
        calls.push(`register:${name}`);
        if (name === "broken") throw new Error("invalid config");
      },
      unregisterMcpServer(name: string): void {
        calls.push(`unregister:${name}`);
      },
    };

    const result = reconcileMcpRegistrations(
      registrar,
      new Set(["broken"]),
      [
        { name: "broken", config: {} },
        { name: "working", config: { command: "server" } },
      ],
    );

    expect(calls).toEqual([
      "register:broken",
      "unregister:broken",
      "register:working",
    ]);
    expect([...result.registeredNames]).toEqual(["working"]);
    expect(result.errors).toEqual([{ name: "broken", error: "invalid config" }]);
  });
});
