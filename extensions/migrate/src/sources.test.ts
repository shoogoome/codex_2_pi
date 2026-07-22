import { describe, expect, it } from "vitest";
import { candidateRoots, detectMemoryFiles, detectSources } from "./sources.js";
import type { FsFacade } from "./types.js";

/** Build an in-memory FsFacade from a set of file paths and dir paths. */
function fakeFs(files: Set<string>, dirs: Set<string>): FsFacade {
  return {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return "";
    },
    readdirSync: () => [],
    isDirectory: (p) => dirs.has(p),
  };
}

const HOME = "/home/u";
const CWD = "/proj";

describe("candidateRoots", () => {
  it("orders project before user, claude before cursor", () => {
    const roots = candidateRoots(HOME, CWD);
    expect(roots.map((r) => `${r.kind}:${r.scope}`)).toEqual([
      "claude:project",
      "cursor:project",
      "claude:user",
      "cursor:user",
    ]);
  });
});

describe("detectSources", () => {
  it("returns only roots that exist as directories", () => {
    const dirs = new Set<string>([`${CWD}/.claude`]);
    const files = new Set<string>([`${CWD}/.claude/settings.json`]);
    const sources = detectSources(HOME, CWD, fakeFs(files, dirs));
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("claude");
    expect(sources[0].scope).toBe("project");
    expect(sources[0].files.settings).toBe(`${CWD}/.claude/settings.json`);
  });

  it("detects claude subdirs and cursor mcp.json distinctly", () => {
    const dirs = new Set<string>([
      `${HOME}/.claude`,
      `${HOME}/.claude/agents`,
      `${HOME}/.claude/commands`,
      `${CWD}/.cursor`,
      `${CWD}/.cursor/rules`,
    ]);
    const files = new Set<string>([
      `${HOME}/.claude/.mcp.json`,
      `${CWD}/.cursor/mcp.json`,
    ]);
    const sources = detectSources(HOME, CWD, fakeFs(files, dirs));
    const claude = sources.find((s) => s.kind === "claude");
    const cursor = sources.find((s) => s.kind === "cursor");
    expect(claude?.files.agentsDir).toBe(`${HOME}/.claude/agents`);
    expect(claude?.files.commandsDir).toBe(`${HOME}/.claude/commands`);
    expect(claude?.files.mcpJson).toBe(`${HOME}/.claude/.mcp.json`);
    expect(cursor?.files.mcpJson).toBe(`${CWD}/.cursor/mcp.json`);
    expect(cursor?.files.rulesDir).toBe(`${CWD}/.cursor/rules`);
    // Cursor has no agents/commands surface.
    expect(cursor?.files.agentsDir).toBeUndefined();
  });

  it("returns nothing when no roots exist", () => {
    expect(detectSources(HOME, CWD, fakeFs(new Set(), new Set()))).toEqual([]);
  });
});

describe("detectMemoryFiles", () => {
  it("finds project and user CLAUDE.md files", () => {
    const files = new Set<string>([`${CWD}/CLAUDE.md`, `${HOME}/.claude/CLAUDE.md`]);
    const found = detectMemoryFiles(HOME, CWD, fakeFs(files, new Set()));
    expect(found).toContain(`${CWD}/CLAUDE.md`);
    expect(found).toContain(`${HOME}/.claude/CLAUDE.md`);
  });
});
