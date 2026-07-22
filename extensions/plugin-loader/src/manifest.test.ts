import { describe, it, expect } from "vitest";
import { parseManifest, minimalManifest } from "./manifest.js";

describe("parseManifest", () => {
  it("tolerates a completely missing/empty manifest", () => {
    const m = parseManifest(undefined, "fallback");
    expect(m.name).toBe("fallback");
    expect(m.commands).toEqual([]);
    expect(m.skills).toEqual([]);
    expect(m.mcpServers).toEqual({ inline: {}, paths: [] });
  });

  it("falls back to dir name when name omitted", () => {
    const m = parseManifest(JSON.stringify({ version: "1.0.0" }), "dirname");
    expect(m.name).toBe("dirname");
    expect(m.version).toBe("1.0.0");
  });

  it("returns minimal manifest on malformed JSON", () => {
    const m = parseManifest("{not valid json", "broken");
    expect(m.name).toBe("broken");
    expect(m.commands).toEqual([]);
  });

  it("ignores non-object JSON (array/number)", () => {
    expect(parseManifest("[1,2,3]", "x").name).toBe("x");
    expect(parseManifest("42", "y").name).toBe("y");
  });

  it("normalizes commands: single string form", () => {
    const m = parseManifest(JSON.stringify({ name: "p", commands: "./cmd/a.md" }), "p");
    expect(m.commands).toEqual([{ source: "./cmd/a.md" }]);
  });

  it("normalizes commands: array form", () => {
    const m = parseManifest(JSON.stringify({ name: "p", commands: ["a.md", "b.md"] }), "p");
    expect(m.commands).toEqual([{ source: "a.md" }, { source: "b.md" }]);
  });

  it("normalizes commands: record form with metadata", () => {
    const m = parseManifest(
      JSON.stringify({
        name: "p",
        commands: {
          deploy: { source: "d.md", description: "Deploy", "argument-hint": "<env>", "allowed-tools": ["bash"] },
          bare: 123,
        },
      }),
      "p",
    );
    const deploy = m.commands.find((c) => c.name === "deploy");
    expect(deploy).toMatchObject({
      name: "deploy",
      source: "d.md",
      description: "Deploy",
      argumentHint: "<env>",
      allowedTools: ["bash"],
    });
    // Non-object meta still produces a bare entry.
    expect(m.commands.find((c) => c.name === "bare")).toEqual({ name: "bare" });
  });

  it("normalizes skills/agents/outputStyles single|array", () => {
    const m = parseManifest(
      JSON.stringify({ name: "p", skills: "skills/x", agents: ["a.md"], "output-styles": "s.md" }),
      "p",
    );
    expect(m.skills).toEqual(["skills/x"]);
    expect(m.agents).toEqual(["a.md"]);
    expect(m.outputStyles).toEqual(["s.md"]);
  });

  it("normalizes inline mcpServers record", () => {
    const m = parseManifest(
      JSON.stringify({ name: "p", mcpServers: { db: { command: "run" } } }),
      "p",
    );
    expect(m.mcpServers.inline).toEqual({ db: { command: "run" } });
    expect(m.mcpServers.paths).toEqual([]);
  });

  it("normalizes mcpServers path string and mixed array", () => {
    const m = parseManifest(
      JSON.stringify({ name: "p", mcpServers: ["./.mcp.json", { web: { url: "u" } }] }),
      "p",
    );
    expect(m.mcpServers.paths).toEqual(["./.mcp.json"]);
    expect(m.mcpServers.inline).toEqual({ web: { url: "u" } });
  });

  it("accepts an already-parsed object", () => {
    const m = parseManifest({ name: "obj", description: "d" }, "fb");
    expect(m.name).toBe("obj");
    expect(m.description).toBe("d");
  });

  it("keeps raw hooks for later reporting", () => {
    const m = parseManifest(JSON.stringify({ name: "p", hooks: "hooks/hooks.json" }), "p");
    expect(m.hooks).toBe("hooks/hooks.json");
  });
});

describe("minimalManifest", () => {
  it("produces empty collections", () => {
    const m = minimalManifest("z");
    expect(m).toEqual({
      name: "z",
      commands: [],
      agents: [],
      skills: [],
      outputStyles: [],
      mcpServers: { inline: {}, paths: [] },
    });
  });
});
