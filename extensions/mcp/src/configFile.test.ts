import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeConfigPaths,
  parseMcpConfig,
  mergeMcpConfigs,
  applyServerToConfigText,
  removeServerFromConfigText,
} from "./config.js";
import type { McpStdioConfig } from "./types.js";

// Real filesystem round-trip in a throwaway temp dir. This exercises the exact
// read → mutate-text → write cycle that index.ts's /mcp add and /mcp remove run,
// plus the global/project layering computeConfigPaths + mergeMcpConfigs drive.
// No process spawn, no network — only local temp-dir file I/O.

const dirs: string[] = [];
function makeTempTree(): { home: string; cwd: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-"));
  dirs.push(root);
  return { home: path.join(root, "home"), cwd: path.join(root, "proj") };
}

function readSafe(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// Mirror index.ts writeProjectConfig: read current text, mutate, mkdir -p, write.
function writeProjectConfig(projectPath: string, mutate: (text: string) => string): void {
  const next = mutate(readSafe(projectPath));
  mkdirSync(path.dirname(projectPath), { recursive: true });
  writeFileSync(projectPath, next, "utf8");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("config file read/write round-trip (temp dir)", () => {
  it("computes paths and /mcp add creates the project file with the server", () => {
    const { home, cwd } = makeTempTree();
    const { globalPath, projectPath } = computeConfigPaths(home, cwd);
    expect(globalPath).toBe(path.join(home, ".pi", "agent", "mcp.json"));
    expect(projectPath).toBe(path.join(cwd, ".pi", "mcp.json"));
    expect(existsSync(projectPath)).toBe(false);

    writeProjectConfig(projectPath, (text) =>
      applyServerToConfigText(text, "fs", { command: "node", args: ["server.js"] }),
    );

    expect(existsSync(projectPath)).toBe(true);
    const { servers, errors } = parseMcpConfig(readSafe(projectPath));
    expect(errors).toEqual([]);
    expect((servers.fs as McpStdioConfig).command).toBe("node");
    expect((servers.fs as McpStdioConfig).args).toEqual(["server.js"]);
  });

  it("/mcp add then /mcp remove leaves other servers intact on disk", () => {
    const { home, cwd } = makeTempTree();
    const { projectPath } = computeConfigPaths(home, cwd);

    writeProjectConfig(projectPath, (t) => applyServerToConfigText(t, "a", { command: "x" }));
    writeProjectConfig(projectPath, (t) =>
      applyServerToConfigText(t, "b", { type: "http", url: "https://b.example" }),
    );
    expect(Object.keys(parseMcpConfig(readSafe(projectPath)).servers).sort()).toEqual(["a", "b"]);

    writeProjectConfig(projectPath, (t) => removeServerFromConfigText(t, "a"));
    const after = parseMcpConfig(readSafe(projectPath)).servers;
    expect(after.a).toBeUndefined();
    expect(after.b).toBeDefined();
  });

  it("merges a global file and a project file with project winning on disk", () => {
    const { home, cwd } = makeTempTree();
    const { globalPath, projectPath } = computeConfigPaths(home, cwd);

    mkdirSync(path.dirname(globalPath), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        mcpServers: {
          shared: { command: "global-cmd" },
          onlyGlobal: { command: "g" },
        },
      }),
      "utf8",
    );
    writeProjectConfig(projectPath, (t) => applyServerToConfigText(t, "shared", { command: "project-cmd" }));
    writeProjectConfig(projectPath, (t) => applyServerToConfigText(t, "onlyProject", { command: "p" }));

    const g = parseMcpConfig(readSafe(globalPath));
    const p = parseMcpConfig(readSafe(projectPath));
    expect(g.errors).toEqual([]);
    expect(p.errors).toEqual([]);

    const merged = mergeMcpConfigs(g.servers, p.servers);
    expect(Object.keys(merged).sort()).toEqual(["onlyGlobal", "onlyProject", "shared"]);
    expect(merged.onlyGlobal.source).toBe("global");
    expect(merged.onlyProject.source).toBe("project");
    expect(merged.shared.source).toBe("project");
    expect((merged.shared.config as McpStdioConfig).command).toBe("project-cmd");
  });

  it("preserves unrelated top-level keys across a write cycle", () => {
    const { home, cwd } = makeTempTree();
    const { projectPath } = computeConfigPaths(home, cwd);
    mkdirSync(path.dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ $schema: "x", mcpServers: {} }), "utf8");

    writeProjectConfig(projectPath, (t) => applyServerToConfigText(t, "a", { command: "c" }));
    const parsed = JSON.parse(readSafe(projectPath));
    expect(parsed.$schema).toBe("x");
    expect(parsed.mcpServers.a).toEqual({ command: "c" });
  });
});
