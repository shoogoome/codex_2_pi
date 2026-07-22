import { describe, expect, it } from "vitest";
import {
  applyServerToConfigText,
  existingServerNames,
  normalizeServerConfig,
  serverHasSecrets,
} from "./mapMcp.js";

describe("normalizeServerConfig", () => {
  it("normalizes stdio entries", () => {
    expect(normalizeServerConfig({ command: "npx", args: ["a", 1, "b"], env: { X: "1", Y: 2 } })).toEqual({
      command: "npx",
      args: ["a", "b"],
      env: { X: "1" },
    });
  });

  it("normalizes http/sse entries", () => {
    expect(normalizeServerConfig({ url: "https://x", headers: { A: "b" } })).toEqual({
      type: "http",
      url: "https://x",
      headers: { A: "b" },
    });
    expect(normalizeServerConfig({ type: "sse", url: "https://y" })).toEqual({ type: "sse", url: "https://y" });
  });

  it("returns undefined for unclassifiable entries", () => {
    expect(normalizeServerConfig({ foo: "bar" })).toBeUndefined();
    expect(normalizeServerConfig(null)).toBeUndefined();
  });
});

describe("serverHasSecrets", () => {
  it("flags env / headers presence", () => {
    expect(serverHasSecrets({ command: "x", env: { T: "1" } })).toBe(true);
    expect(serverHasSecrets({ command: "x" })).toBe(false);
    expect(serverHasSecrets({ type: "http", url: "u", headers: { A: "b" } })).toBe(true);
    expect(serverHasSecrets({ type: "http", url: "u" })).toBe(false);
  });
});

describe("existingServerNames / applyServerToConfigText", () => {
  it("lists existing names and preserves other top-level keys on merge", () => {
    const start = JSON.stringify({ version: 1, mcpServers: { a: { command: "a" } } });
    expect([...existingServerNames(start)]).toEqual(["a"]);

    const next = applyServerToConfigText(start, "b", { command: "b" });
    const parsed = JSON.parse(next);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["a", "b"]);
    expect(next.endsWith("\n")).toBe(true);
  });

  it("handles empty / malformed text as an empty config", () => {
    expect([...existingServerNames("")]).toEqual([]);
    expect([...existingServerNames("{ broken")]).toEqual([]);
    const out = applyServerToConfigText("", "a", { command: "a" });
    expect(JSON.parse(out).mcpServers.a).toEqual({ command: "a" });
  });
});
