import { describe, expect, it } from "vitest";
import { buildPlan, computeTargets, createCount, renderPlan } from "./plan.js";
import type { FsFacade, ParsedConfig } from "./types.js";

const CWD = "/proj";
const T = computeTargets(CWD);

function fakeFs(fileContents: Record<string, string>, dirs: Set<string> = new Set()): FsFacade {
  return {
    existsSync: (p) => p in fileContents || dirs.has(p),
    readFileSync: (p) => {
      if (!(p in fileContents)) throw new Error(`ENOENT ${p}`);
      return fileContents[p];
    },
    readdirSync: () => [],
    isDirectory: (p) => dirs.has(p),
  };
}

function parsed(overrides: Partial<ParsedConfig> = {}): ParsedConfig {
  return {
    mcpServers: [],
    agents: [],
    commands: [],
    hooks: [],
    memory: [],
    warnings: [],
    ...overrides,
  };
}

describe("buildPlan — only-missing dedup", () => {
  it("skips MCP servers already present, creates the rest", () => {
    const existing = JSON.stringify({ mcpServers: { a: { command: "a" } } });
    const p = parsed({
      mcpServers: [
        { name: "a", config: { command: "a" }, origin: "x" },
        { name: "b", config: { command: "b" }, origin: "x" },
      ],
    });
    const plan = buildPlan(p, fakeFs({ [T.mcpPath]: existing }), CWD);
    const a = plan.items.find((i) => i.name === "a")!;
    const b = plan.items.find((i) => i.name === "b")!;
    expect(a.action).toBe("skip");
    expect(a.skipReason).toMatch(/already/);
    expect(b.action).toBe("create");
    expect(createCount(plan)).toBe(1);
  });

  it("skips agents whose target file already exists", () => {
    const p = parsed({ agents: [{ name: "reviewer", body: "x", origin: "y" }] });
    const target = `${T.agentsDir}/reviewer.md`;
    const plan = buildPlan(p, fakeFs({ [target]: "existing" }), CWD);
    expect(plan.items[0].action).toBe("skip");
  });

  it("dedups duplicate command names within the same run", () => {
    const p = parsed({
      commands: [
        { relPath: "deploy.md", source: "a", origin: "1" },
        { relPath: "deploy.md", source: "b", origin: "2" },
      ],
    });
    const plan = buildPlan(p, fakeFs({}), CWD);
    const creates = plan.items.filter((i) => i.action === "create");
    const skips = plan.items.filter((i) => i.action === "skip");
    expect(creates).toHaveLength(1);
    expect(skips[0].skipReason).toMatch(/duplicate/);
  });

  it("skips hook triples already in hooks.json, creates new ones", () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] },
    });
    const p = parsed({
      hooks: [
        { event: "Stop", hookType: "command", command: "old", origin: "x" },
        { event: "Stop", hookType: "command", command: "new", origin: "x" },
      ],
    });
    const plan = buildPlan(p, fakeFs({ [T.hooksPath]: existing }), CWD);
    expect(plan.items.find((i) => i.preview.includes("old"))!.action).toBe("skip");
    expect(plan.items.find((i) => i.preview.includes("new"))!.action).toBe("create");
  });

  it("treats memory as informational skip, never a create", () => {
    const p = parsed({ memory: [{ path: "/proj/CLAUDE.md", note: "loaded natively" }] });
    const plan = buildPlan(p, fakeFs({}), CWD);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("skip");
    expect(createCount(plan)).toBe(0);
  });

  it("honors category selection", () => {
    const p = parsed({
      mcpServers: [{ name: "a", config: { command: "a" }, origin: "x" }],
      agents: [{ name: "r", body: "b", origin: "y" }],
    });
    const plan = buildPlan(p, fakeFs({}), CWD, ["mcp"]);
    expect(plan.items.every((i) => i.category === "mcp")).toBe(true);
  });
});

describe("renderPlan", () => {
  it("summarizes create/skip counts and lists warnings", () => {
    const p = parsed({
      mcpServers: [{ name: "a", config: { command: "a" }, origin: "x" }],
      warnings: [{ file: "f", message: "oops" }],
    });
    const text = renderPlan(buildPlan(p, fakeFs({}), CWD));
    expect(text).toContain("MCP servers");
    expect(text).toContain("+ mcp a");
    expect(text).toContain("Warnings:");
    expect(text).toContain("f: oops");
    expect(text).toContain("Total to create: 1");
  });

  it("says nothing-to-migrate when everything already exists", () => {
    const text = renderPlan(buildPlan(parsed(), fakeFs({}), CWD));
    expect(text).toContain("Nothing to migrate");
  });
});
