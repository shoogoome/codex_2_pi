import { describe, expect, it } from "vitest";
import { parseClaudeSource, anyServerHasSecrets } from "./parseClaude.js";
import type { DetectedSource, FsFacade } from "./types.js";

/** In-memory fs from a path→content map; dirs listed explicitly. */
function fakeFs(fileContents: Record<string, string>, dirEntries: Record<string, string[]>): FsFacade {
  const dirs = new Set(Object.keys(dirEntries));
  return {
    existsSync: (p) => p in fileContents || dirs.has(p),
    readFileSync: (p) => {
      if (!(p in fileContents)) throw new Error(`ENOENT ${p}`);
      return fileContents[p];
    },
    readdirSync: (p) => dirEntries[p] ?? [],
    isDirectory: (p) => dirs.has(p),
  };
}

function claudeSource(files: DetectedSource["files"]): DetectedSource {
  return { kind: "claude", scope: "project", root: "/proj/.claude", files };
}

describe("parseClaudeSource — mcp", () => {
  it("parses stdio and http servers from settings.json", () => {
    const settings = "/proj/.claude/settings.json";
    const contents = {
      [settings]: JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "abc" } },
          api: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer z" } },
          bad: { nonsense: true },
        },
      }),
    };
    const parsed = parseClaudeSource(claudeSource({ settings }), fakeFs(contents, {}));
    const names = parsed.mcpServers.map((s) => s.name).sort();
    expect(names).toEqual(["api", "fs"]);
    const fs = parsed.mcpServers.find((s) => s.name === "fs")!;
    expect(fs.config).toMatchObject({ command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "abc" } });
    expect(parsed.warnings.some((w) => w.message.includes("bad"))).toBe(true);
    expect(anyServerHasSecrets(parsed)).toBe(true);
  });

  it("merges settings.local.json and .mcp.json", () => {
    const settings = "/proj/.claude/settings.json";
    const local = "/proj/.claude/settings.local.json";
    const mcp = "/proj/.claude/.mcp.json";
    const contents = {
      [settings]: JSON.stringify({ mcpServers: { a: { command: "a" } } }),
      [local]: JSON.stringify({ mcpServers: { b: { command: "b" } } }),
      [mcp]: JSON.stringify({ mcpServers: { c: { command: "c" } } }),
    };
    const parsed = parseClaudeSource(
      claudeSource({ settings, settingsLocal: local, mcpJson: mcp }),
      fakeFs(contents, {}),
    );
    expect(parsed.mcpServers.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("degrades on malformed JSON with a warning, never throws", () => {
    const settings = "/proj/.claude/settings.json";
    const parsed = parseClaudeSource(claudeSource({ settings }), fakeFs({ [settings]: "{ not json" }, {}));
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings[0].message).toMatch(/invalid JSON/);
  });
});

describe("parseClaudeSource — hooks", () => {
  it("flattens event→matcher→command triples", () => {
    const settings = "/proj/.claude/settings.json";
    const contents = {
      [settings]: JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo a" }, { type: "command", command: "echo b" }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
    };
    const parsed = parseClaudeSource(claudeSource({ settings }), fakeFs(contents, {}));
    expect(parsed.hooks).toHaveLength(3);
    const pre = parsed.hooks.filter((h) => h.event === "PreToolUse");
    expect(pre.every((h) => h.matcher === "Bash")).toBe(true);
    const stop = parsed.hooks.find((h) => h.event === "Stop");
    expect(stop?.matcher).toBeUndefined();
    expect(stop?.command).toBe("echo stop");
  });

  it("honors disableAllHooks", () => {
    const settings = "/proj/.claude/settings.json";
    const contents = {
      [settings]: JSON.stringify({
        disableAllHooks: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
      }),
    };
    const parsed = parseClaudeSource(claudeSource({ settings }), fakeFs(contents, {}));
    expect(parsed.hooks).toEqual([]);
  });
});

describe("parseClaudeSource — agents & commands", () => {
  it("parses agent frontmatter and nested command files", () => {
    const agentsDir = "/proj/.claude/agents";
    const commandsDir = "/proj/.claude/commands";
    const contents = {
      [`${agentsDir}/reviewer.md`]:
        "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: opus\n---\nBe critical.",
      [`${commandsDir}/deploy.md`]: "---\ndescription: Deploy\n---\nDeploy $ARGUMENTS",
      [`${commandsDir}/git/commit.md`]: "Commit staged changes",
    };
    const dirEntries = {
      [agentsDir]: ["reviewer.md", "notes.txt"],
      [commandsDir]: ["deploy.md", "git"],
      [`${commandsDir}/git`]: ["commit.md"],
    };
    const parsed = parseClaudeSource(
      claudeSource({ agentsDir, commandsDir }),
      fakeFs(contents, dirEntries),
    );
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toMatchObject({
      name: "reviewer",
      description: "Reviews code",
      tools: "Read, Grep",
      model: "opus",
    });
    expect(parsed.agents[0].body).toContain("Be critical.");
    expect(parsed.commands.map((c) => c.relPath).sort()).toEqual(["deploy.md", "git/commit.md"]);
  });
});
