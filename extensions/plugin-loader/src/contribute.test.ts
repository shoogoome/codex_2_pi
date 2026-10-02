import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  commandFilesFor,
  deferredFor,
  mcpServerSourcePaths,
  skillPathsFor,
  outputStylePathsFor,
  agentPathsFor,
  themePathsFor,
} from "./contribute.js";
import { discoverPlugins, type FsFacade } from "./discover.js";
import {
  buildMcpRegistrations,
  mergeServers,
  normalizeServersObject,
} from "./mcp.js";
import { transformCommand } from "./commandTransform.js";
import type { DiscoveredPlugin } from "./types.js";

// A real node:fs-backed facade, mirroring the one index.ts constructs. The temp
// dir here holds no shell/network/process — just files — so exercising real fs
// discovery + contribution is safe and matches the shipped code path.
const realFs: FsFacade = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  readdirSync: (p) => fs.readdirSync(p),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

function listMarkdown(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => join(dir, f));
}

/** Collect merged servers exactly as index.ts collectServers does, but pure. */
function collectServers(plugin: DiscoveredPlugin): Record<string, unknown> {
  const sources: Record<string, unknown>[] = [];
  for (const p of mcpServerSourcePaths(plugin)) {
    try {
      sources.push(normalizeServersObject(JSON.parse(fs.readFileSync(p, "utf8"))));
    } catch {
      /* ignore */
    }
  }
  sources.push(normalizeServersObject(plugin.manifest.mcpServers.inline));
  return mergeServers(...sources);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "plugin-loader-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a Claude-style plugin tree under `<tmp>/<roots>/<name>`. */
function makePlugin(rootsDir: string, name: string, tree: Record<string, string>): string {
  const pluginRoot = join(tmp, rootsDir, name);
  for (const [rel, content] of Object.entries(tree)) {
    const full = join(pluginRoot, rel);
    fs.mkdirSync(join(full, ".."), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  fs.mkdirSync(pluginRoot, { recursive: true });
  return pluginRoot;
}

describe("discovery + contribution over a real temp dir", () => {
  it("discovers a fake plugin and maps its components to pi resource types", () => {
    const root = makePlugin("roots", "acme", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "acme",
        version: "2.3.0",
        commands: { extra: { source: "extra/more.md", description: "Extra" } },
      }),
      "skills/helper/SKILL.md": "# skill",
      "themes/dark.json": "{}",
      "output-styles/concise.md": "---\nname: Concise\n---\nBe brief.",
      "commands/deploy.md": "---\ndescription: Deploy\n---\nDeploy to ${CLAUDE_PLUGIN_ROOT}/env",
      "commands/notes.txt": "ignored (not markdown)",
      "extra/more.md": "Extra command body",
      "hooks/hooks.json": "{}",
      "agents/reviewer.md": "# agent",
    });
    const rootsDir = join(tmp, "roots");

    const plugins = discoverPlugins([rootsDir], realFs);
    expect(plugins).toHaveLength(1);
    const plugin = plugins[0]!;
    expect(plugin.name).toBe("acme");
    expect(plugin.manifestKind).toBe("claude");
    expect(plugin.manifest.version).toBe("2.3.0");

    // skills/ and themes/ map straight to skillPaths / themePaths.
    expect(skillPathsFor(plugin.dirs)).toEqual([join(root, "skills")]);
    expect(themePathsFor(plugin.dirs)).toEqual([join(root, "themes")]);
    expect(outputStylePathsFor(plugin.dirs)).toEqual([join(root, "output-styles")]);
    expect(agentPathsFor(plugin)).toEqual([join(root, "agents")]);

    // commands/*.md plus manifest-declared sources become command files; the
    // non-markdown file is excluded, the manifest `extra/more.md` is included.
    const cmdFiles = commandFilesFor(plugin, listMarkdown(plugin.dirs.commands!));
    expect(cmdFiles).toContain(join(root, "commands", "deploy.md"));
    expect(cmdFiles).toContain(join(root, "extra", "more.md"));
    expect(cmdFiles).not.toContain(join(root, "commands", "notes.txt"));

    // A command transforms into a namespaced prompt with CLAUDE_PLUGIN_ROOT filled.
    const out = transformCommand({
      pluginName: plugin.name,
      commandName: "deploy",
      source: fs.readFileSync(join(root, "commands", "deploy.md"), "utf8"),
      pluginRoot: root,
    });
    expect(out.filename).toBe("acme_deploy.md");
    expect(out.content).toContain(`Deploy to ${root}/env`);

    // hooks + agents are recognized but deferred, never silently dropped.
    expect(deferredFor(plugin.dirs).sort()).toEqual(["agents", "hooks"]);
  });

  it("merges MCP sources with .mcp.json < manifest paths < inline precedence", () => {
    const root = makePlugin("roots", "srv", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "srv",
        mcpServers: [
          "config/extra.json",
          { shared: { command: "inline-wins" }, inlineOnly: { url: "http://inline" } },
        ],
      }),
      ".mcp.json": JSON.stringify({
        mcpServers: {
          base: { command: "${CLAUDE_PLUGIN_ROOT}/bin/base" },
          shared: { command: "from-mcp-json" },
        },
      }),
      "config/extra.json": JSON.stringify({
        shared: { command: "from-manifest-path" },
        extra: { url: "http://extra" },
      }),
    });
    const rootsDir = join(tmp, "roots");
    const plugin = discoverPlugins([rootsDir], realFs)[0]!;

    // Ordered sources: convention .mcp.json first, then manifest path.
    expect(mcpServerSourcePaths(plugin)).toEqual([
      join(root, ".mcp.json"),
      join(root, "config", "extra.json"),
    ]);

    const merged = collectServers(plugin);
    expect(Object.keys(merged).sort()).toEqual(["base", "extra", "inlineOnly", "shared"]);
    // shared is defined in all three sources; inline manifest wins.
    expect(merged.shared).toEqual({ command: "inline-wins" });

    // Registrations are namespaced <plugin>_<server> (sanitized to an
    // OpenAI-legal charset, never ':') with CLAUDE_PLUGIN_ROOT substituted —
    // the payload shape the mcp extension listens for.
    const regs = buildMcpRegistrations(plugin.name, merged, root);
    const byName = Object.fromEntries(regs.map((r) => [r.name, r.config]));
    expect(byName["srv_base"]).toEqual({ command: `${root}/bin/base` });
    expect(byName["srv_shared"]).toEqual({ command: "inline-wins" });
    for (const reg of regs) expect(reg.name).not.toContain(":");
    // Each registration is exactly { name, config } — consumed by Pi 1.0's native API.
    for (const reg of regs) {
      expect(Object.keys(reg).sort()).toEqual(["config", "name"]);
    }
  });

  it("discovers a manifest-less plugin dir with graceful fallbacks", () => {
    const root = makePlugin("roots", "bare", {
      "skills/x/SKILL.md": "# x",
    });
    const plugin = discoverPlugins([join(tmp, "roots")], realFs)[0]!;
    expect(plugin.name).toBe("bare");
    expect(plugin.manifestKind).toBe("none");
    expect(skillPathsFor(plugin.dirs)).toEqual([join(root, "skills")]);
    expect(themePathsFor(plugin.dirs)).toEqual([]);
    expect(deferredFor(plugin.dirs)).toEqual([]);
    expect(collectServers(plugin)).toEqual({});
  });
});
