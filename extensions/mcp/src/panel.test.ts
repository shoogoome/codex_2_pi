import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  McpPanel,
  filterServers,
  filterTools,
  sortServers,
  statusIcon,
  maskSecrets,
  fullToolName,
  extractToolParams,
  toolAnnotation,
  parseKvPairs,
  parseArgs,
  buildServerConfig,
  windowSlice,
  matchesFilter,
  type AddServerForm,
  type McpPanelDeps,
  type McpServerRow,
  type PanelTheme,
} from "./panel.js";
import {
  computeConfigPaths,
  configPathForSource,
  applyServerToConfigText,
  removeServerFromConfigText,
  parseMcpConfig,
} from "./config.js";
import type { McpToolDef } from "./types.js";

// ── raw terminal key sequences (same set as plugin-loader panel.test.ts) ─────
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  ctrlC: "\x03",
} as const;

/** Identity theme → render output is clean ASCII we can assert against. */
const theme: PanelTheme = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => t,
  inverse: (t) => t,
};

interface Calls {
  reconnect: string[];
  addServer: Array<{ name: string; scope: string; config: unknown }>;
  removeServer: string[];
}

function defaultServers(): McpServerRow[] {
  return [
    {
      id: "github",
      rawName: "github",
      transport: "stdio",
      source: "project",
      status: "connected",
      toolCount: 4,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "super-secret-value" },
    },
    { id: "local-fs", rawName: "local-fs", transport: "stdio", source: "project", status: "disconnected", toolCount: 0, command: "node" },
    { id: "km", rawName: "km", transport: "http", source: "global", status: "connected", toolCount: 2, url: "https://km.example/mcp", headers: { Authorization: "Bearer abc" } },
    { id: "zhiyan-log", rawName: "zhiyan-log", transport: "http", source: "runtime", status: "error", error: "ECONNREFUSED", toolCount: 0, url: "https://z.example/mcp" },
  ];
}

function defaultTools(): Record<string, McpToolDef[]> {
  return {
    github: [
      {
        name: "create_issue",
        description: "Create a new issue in a repository.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/name" },
            title: { type: "string" },
            body: { type: "string", description: "markdown body" },
            labels: { type: "array" },
          },
          required: ["repo", "title"],
        },
      },
      { name: "get_issue", description: "Get an issue" },
      { name: "list_issues" },
      { name: "search_issues" },
    ],
    km: [{ name: "search" }, { name: "query" }],
  };
}

function makeDeps(
  overrides: {
    servers?: McpServerRow[];
    tools?: Record<string, McpToolDef[]>;
    reconnectResult?: (row: McpServerRow) => void;
    addResult?: McpServerRow["status"];
  } = {},
) {
  const servers = overrides.servers ?? defaultServers();
  const tools = overrides.tools ?? defaultTools();
  const calls: Calls = { reconnect: [], addServer: [], removeServer: [] };
  const deps: McpPanelDeps = {
    listServers: () => servers.map((s) => ({ ...s })),
    toolsFor: (id) => tools[id] ?? [],
    configPaths: () => ({ projectPath: "/repo/.pi/mcp.json", globalPath: "/home/.pi/agent/mcp.json" }),
    reconnect: async (id) => {
      calls.reconnect.push(id);
      const row = servers.find((s) => s.id === id);
      if (row) {
        if (overrides.reconnectResult) overrides.reconnectResult(row);
        else {
          row.status = "connected";
          row.toolCount = (tools[id] ?? []).length;
        }
      }
    },
    addServer: async ({ name, scope, config }) => {
      calls.addServer.push({ name, scope, config });
      const status = overrides.addResult ?? "connected";
      servers.push({ id: name, rawName: name, transport: "stdio", source: scope, status, toolCount: 0 });
      return { status };
    },
    removeServer: (id) => {
      calls.removeServer.push(id);
      const idx = servers.findIndex((s) => s.id === id);
      const source = servers[idx]?.source;
      if (idx >= 0) servers.splice(idx, 1);
      return { removedFromFile: source !== "runtime", message: `removed ${id}` };
    },
  };
  return { deps, servers, tools, calls };
}

function makePanel(bundle = makeDeps()) {
  const done = vi.fn();
  const panel = new McpPanel(theme, bundle.deps, done);
  panel.requestRender = () => {};
  return { panel, done, ...bundle };
}

function feed(panel: McpPanel, ...keys: string[]): void {
  for (const k of keys) panel.handleInput(k);
}

function renderText(panel: McpPanel, width = 80): string {
  return panel.render(width).join("\n");
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("matchesFilter is case-insensitive and matches any field", () => {
    expect(matchesFilter(["GitHub", "stdio"], "hub")).toBe(true);
    expect(matchesFilter(["github"], "")).toBe(true);
    expect(matchesFilter(["github"], "zzz")).toBe(false);
  });

  it("filterServers filters over name/transport/source/status", () => {
    const rows = defaultServers();
    expect(filterServers(rows, "km").map((r) => r.id)).toEqual(["km"]);
    expect(filterServers(rows, "runtime").map((r) => r.id)).toEqual(["zhiyan-log"]);
    expect(filterServers(rows, "stdio").map((r) => r.id).sort()).toEqual(["github", "local-fs"]);
  });

  it("filterTools filters over name and description", () => {
    const tools = defaultTools().github;
    expect(filterTools(tools, "issue").length).toBe(4);
    expect(filterTools(tools, "create").map((t) => t.name)).toEqual(["create_issue"]);
  });

  it("sortServers groups project → global → runtime then name", () => {
    const sorted = sortServers(defaultServers());
    expect(sorted.map((r) => r.source)).toEqual(["project", "project", "global", "runtime"]);
    // within project group, alphabetical
    expect(sorted.slice(0, 2).map((r) => r.id)).toEqual(["github", "local-fs"]);
  });

  it("statusIcon maps state to icon/color, with connecting override", () => {
    expect(statusIcon("connected")).toMatchObject({ icon: "✔", color: "success" });
    expect(statusIcon("disconnected")).toMatchObject({ icon: "○", color: "dim" });
    expect(statusIcon("error")).toMatchObject({ icon: "✗", color: "error" });
    expect(statusIcon("connected", true)).toMatchObject({ icon: "…", color: "warning", word: "connecting" });
  });

  it("maskSecrets hides values and returns em-dash when empty", () => {
    expect(maskSecrets({ GITHUB_TOKEN: "abc", FOO: "bar" })).toBe("GITHUB_TOKEN=***, FOO=***");
    expect(maskSecrets({})).toBe("—");
    expect(maskSecrets(undefined)).toBe("—");
  });

  it("fullToolName builds the registered mcp__ name", () => {
    expect(fullToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  it("extractToolParams reads properties + required flags", () => {
    const params = extractToolParams(defaultTools().github[0]!.inputSchema);
    expect(params).toEqual([
      { name: "repo", type: "string", required: true, description: "owner/name" },
      { name: "title", type: "string", required: true, description: undefined },
      { name: "body", type: "string", required: false, description: "markdown body" },
      { name: "labels", type: "array", required: false, description: undefined },
    ]);
    expect(extractToolParams(undefined)).toEqual([]);
    expect(extractToolParams({ type: "object" })).toEqual([]);
  });

  it("toolAnnotation only surfaces annotations when present", () => {
    expect(toolAnnotation({ name: "x" })).toBeUndefined();
    expect(toolAnnotation({ name: "x", annotations: { destructiveHint: true } } as McpToolDef)).toMatchObject({ label: "destructive", color: "error" });
    expect(toolAnnotation({ name: "x", annotations: { readOnlyHint: true } } as McpToolDef)).toMatchObject({ label: "read-only", color: "success" });
  });

  it("parseKvPairs / parseArgs parse form fields", () => {
    expect(parseKvPairs("A=1, B=2 , C=x=y")).toEqual({ A: "1", B: "2", C: "x=y" });
    expect(parseKvPairs("  ")).toEqual({});
    expect(parseKvPairs("nokey")).toEqual({});
    expect(parseArgs("-y  pkg")).toEqual(["-y", "pkg"]);
    expect(parseArgs("  ")).toEqual([]);
  });

  it("buildServerConfig builds stdio/http and rejects missing required field", () => {
    const base: AddServerForm = { transport: "stdio", scope: "project", name: "x", command: "npx", args: "-y pkg", env: "K=v", url: "", headers: "" };
    expect(buildServerConfig(base)).toEqual({ command: "npx", args: ["-y", "pkg"], env: { K: "v" } });
    expect(buildServerConfig({ ...base, command: "" })).toBeUndefined();
    const http: AddServerForm = { transport: "http", scope: "global", name: "y", command: "", args: "", env: "", url: "https://h", headers: "Authorization=Bearer t" };
    expect(buildServerConfig(http)).toEqual({ type: "http", url: "https://h", headers: { Authorization: "Bearer t" } });
    expect(buildServerConfig({ ...http, url: "" })).toBeUndefined();
  });

  it("windowSlice keeps the cursor visible", () => {
    expect(windowSlice(3, 0, 10)).toEqual({ start: 0, end: 3, hasUp: false, hasDown: false });
    const w = windowSlice(30, 20, 10);
    expect(w.hasUp).toBe(true);
    expect(20).toBeGreaterThanOrEqual(w.start);
    expect(20).toBeLessThan(w.end);
  });
});

// ── view state machine + key routing ────────────────────────────────────────

describe("view state machine + key routing", () => {
  it("starts on the list view at cursor 0", () => {
    const { panel } = makePanel();
    expect(panel.snapshot().view).toEqual({ kind: "list" });
    expect(panel.snapshot().cursor).toBe(0);
  });

  it("↑↓ move and clamp", () => {
    const { panel } = makePanel();
    feed(panel, KEY.down, KEY.down);
    expect(panel.snapshot().cursor).toBe(2);
    feed(panel, KEY.up);
    expect(panel.snapshot().cursor).toBe(1);
    feed(panel, KEY.up, KEY.up, KEY.up);
    expect(panel.snapshot().cursor).toBe(0);
  });

  it("Enter drills list → server → tools → tool; Esc returns level by level", () => {
    const { panel } = makePanel();
    // list → server (cursor 0 = github after sort)
    feed(panel, KEY.enter);
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "github" });
    // server menu cursor 0 = "View tools" → tools
    feed(panel, KEY.enter);
    expect(panel.snapshot().view).toEqual({ kind: "tools", id: "github" });
    // tools cursor 0 = create_issue → tool
    feed(panel, KEY.enter);
    expect(panel.snapshot().view).toMatchObject({ kind: "tool", id: "github", tool: "create_issue" });
    // Esc: tool → tools → server → list
    feed(panel, KEY.escape);
    expect(panel.snapshot().view).toEqual({ kind: "tools", id: "github" });
    feed(panel, KEY.escape);
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "github" });
    feed(panel, KEY.escape);
    expect(panel.snapshot().view).toEqual({ kind: "list" });
  });

  it("Esc at list root closes via done()", () => {
    const { panel, done } = makePanel();
    feed(panel, KEY.escape);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("ctrl+c closes from any view", () => {
    const { panel, done } = makePanel();
    feed(panel, KEY.enter); // into server view
    feed(panel, KEY.ctrlC);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("/ enters filter mode, printable filters, Esc exits filter (not the panel)", () => {
    const { panel, done } = makePanel();
    feed(panel, "/");
    expect(panel.snapshot().filterMode).toBe(true);
    feed(panel, "k", "m");
    expect(panel.snapshot().filter).toBe("km");
    // only km remains → Enter drills into km
    feed(panel, KEY.enter); // exits filter mode
    expect(panel.snapshot().filterMode).toBe(false);
    feed(panel, KEY.enter); // drills into the single remaining server
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "km" });
    expect(done).not.toHaveBeenCalled();
  });

  it("r reconnects only the current server (per-server, not all)", async () => {
    const bundle = makeDeps({ servers: [{ id: "local-fs", rawName: "local-fs", transport: "stdio", source: "project", status: "disconnected", toolCount: 0, command: "node" }] });
    const { panel } = makePanel(bundle);
    feed(panel, "r");
    expect(panel.snapshot().status).toContain("reconnecting local-fs");
    await panel.lastOp;
    expect(bundle.calls.reconnect).toEqual(["local-fs"]);
    expect(panel.snapshot().status).toContain("reconnected local-fs");
  });

  it("a opens the add form; x opens the remove confirm", () => {
    const { panel } = makePanel();
    feed(panel, "a");
    expect(panel.snapshot().view).toEqual({ kind: "add" });
    expect(panel.snapshot().addForm).toMatchObject({ transport: "stdio", scope: "project" });
    // escape back to list, then x on github
    feed(panel, KEY.escape);
    feed(panel, "x");
    expect(panel.snapshot().view).toEqual({ kind: "confirm-remove", id: "github" });
  });

  it("confirm-remove Enter on Remove calls removeServer and returns to list", () => {
    const bundle = makeDeps();
    const { panel } = makePanel(bundle);
    feed(panel, "x"); // github → confirm-remove
    feed(panel, KEY.enter); // cursor 0 = Remove
    expect(bundle.calls.removeServer).toEqual(["github"]);
    expect(panel.snapshot().view).toEqual({ kind: "list" });
  });

  it("confirm-remove Cancel returns to the server detail", () => {
    const { panel } = makePanel();
    feed(panel, KEY.enter); // server github
    // Remove server is action index 2
    feed(panel, KEY.down, KEY.down, KEY.enter);
    expect(panel.snapshot().view).toEqual({ kind: "confirm-remove", id: "github" });
    feed(panel, KEY.down, KEY.enter); // cursor 1 = Cancel
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "github" });
  });

  it("View tools on a server with no tools stays put with a hint", () => {
    const { panel } = makePanel();
    feed(panel, KEY.down, KEY.enter); // local-fs server (0 tools)
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "local-fs" });
    feed(panel, KEY.enter); // View tools (0)
    expect(panel.snapshot().view).toEqual({ kind: "server", id: "local-fs" });
    expect(panel.snapshot().status).toContain("No tools");
  });

  it("reconnect is guarded against re-entrancy while in-flight", () => {
    let resolve!: () => void;
    const bundle = makeDeps();
    bundle.deps.reconnect = (id) => {
      bundle.calls.reconnect.push(id);
      return new Promise<void>((r) => (resolve = r));
    };
    const { panel } = makePanel(bundle);
    feed(panel, "r");
    feed(panel, "r"); // ignored while in flight
    expect(bundle.calls.reconnect).toEqual(["github"]);
    resolve();
  });
});

// ── add-server form ──────────────────────────────────────────────────────────

describe("add-server form", () => {
  it("←→ on the Type row cycles transport and reshapes the fields", () => {
    const { panel } = makePanel();
    feed(panel, "a"); // cursor lands on Name (row 2)
    feed(panel, KEY.up, KEY.up); // to Type row (row 0)
    feed(panel, KEY.right);
    expect(panel.snapshot().addForm?.transport).toBe("http");
    feed(panel, KEY.right);
    expect(panel.snapshot().addForm?.transport).toBe("sse");
  });

  it("←→ on the Scope row toggles project/global", () => {
    const { panel } = makePanel();
    feed(panel, "a");
    feed(panel, KEY.up); // Scope row (row 1)
    feed(panel, KEY.right);
    expect(panel.snapshot().addForm?.scope).toBe("global");
  });

  it("fills fields and submits → addServer called with parsed config", async () => {
    const bundle = makeDeps();
    const { panel } = makePanel(bundle);
    feed(panel, "a"); // cursor 2 = Name
    feed(panel, "g", "h");
    feed(panel, KEY.down); // Command (row 3)
    feed(panel, "n", "p", "x");
    feed(panel, KEY.down, KEY.down, KEY.down); // to submit (row 6)
    feed(panel, KEY.enter);
    await panel.lastOp;
    expect(bundle.calls.addServer).toEqual([{ name: "gh", scope: "project", config: { command: "npx" } }]);
    expect(panel.snapshot().view).toEqual({ kind: "list" });
    expect(panel.snapshot().status).toContain("added gh");
  });

  it("submit with a missing required field shows an error and stays on the form", () => {
    const bundle = makeDeps();
    const { panel } = makePanel(bundle);
    feed(panel, "a");
    feed(panel, "g", "h"); // name only, no command
    feed(panel, KEY.down, KEY.down, KEY.down, KEY.down); // to submit
    feed(panel, KEY.enter);
    expect(bundle.calls.addServer).toEqual([]);
    expect(panel.snapshot().view).toEqual({ kind: "add" });
    expect(panel.snapshot().status).toContain("Command are required");
  });

  it("backspace edits the focused field", () => {
    const { panel } = makePanel();
    feed(panel, "a");
    feed(panel, "a", "b", "c", KEY.backspace);
    expect(panel.snapshot().addForm?.name).toBe("ab");
  });
});

// ── rendering ─────────────────────────────────────────────────────────────────

describe("rendering", () => {
  it("list groups by source with config-path headers and status icons", () => {
    const { panel } = makePanel();
    const text = renderText(panel);
    expect(text).toContain("project  (/repo/.pi/mcp.json)");
    expect(text).toContain("global  (/home/.pi/agent/mcp.json)");
    expect(text).toContain("runtime  ((from plugins))");
    expect(text).toContain("✔ connected");
    expect(text).toContain("○ disconnected");
    expect(text).toContain("✗ error: ECONNREFUSED");
    expect(text).toContain("4 servers · 2 connected");
  });

  it("stdio detail masks env values", () => {
    const { panel } = makePanel();
    feed(panel, KEY.enter); // github
    const text = renderText(panel);
    expect(text).toContain("GITHUB_TOKEN=***");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("Command: npx");
  });

  it("remote detail shows Auth not-supported and masks headers", () => {
    const { panel } = makePanel();
    feed(panel, KEY.down, KEY.down, KEY.enter); // km (global http)
    const text = renderText(panel);
    expect(text).toContain("Auth:");
    expect(text).toContain("(not supported)");
    expect(text).toContain("Authorization=***");
    expect(text).toContain("URL:");
  });

  it("error server detail surfaces the error + reconnect hint", () => {
    const { panel } = makePanel();
    feed(panel, KEY.down, KEY.down, KEY.down, KEY.enter); // zhiyan-log (error)
    const text = renderText(panel);
    expect(text).toContain("Error: ECONNREFUSED");
    expect(text).toContain("Reconnect to retry");
  });

  it("tool detail renders full name + inputSchema parameters", () => {
    const { panel } = makePanel();
    feed(panel, KEY.enter, KEY.enter, KEY.enter); // github → tools → create_issue
    const text = renderText(panel);
    expect(text).toContain("Full: mcp__github__create_issue");
    expect(text).toContain("Create a new issue");
    expect(text).toContain("• repo");
    expect(text).toContain("(required)");
    expect(text).toContain("string");
    expect(text).toContain("owner/name");
  });

  it("add form renders type/scope toggles and field labels", () => {
    const { panel } = makePanel();
    feed(panel, "a");
    const text = renderText(panel);
    expect(text).toContain("Type:");
    expect(text).toContain("stdio");
    expect(text).toContain("Scope:");
    expect(text).toContain("Name");
    expect(text).toContain("Command");
    expect(text).toContain("Save & connect");
  });

  it("confirm-remove for a runtime server warns it is memory-only", () => {
    const { panel } = makePanel();
    feed(panel, KEY.down, KEY.down, KEY.down, "x"); // zhiyan-log (runtime)
    const text = renderText(panel);
    expect(text).toContain("runtime (plugin)");
    expect(text).toContain("removed from memory only");
  });
});

// ── regression: /mcp remove writes the file that owns the server (bug fix) ────

describe("configPathForSource (remove-by-source regression)", () => {
  const paths = { globalPath: "/home/.pi/agent/mcp.json", projectPath: "/repo/.pi/mcp.json" };

  it("routes project→projectPath, global→globalPath, runtime→undefined", () => {
    expect(configPathForSource("project", paths)).toBe(paths.projectPath);
    expect(configPathForSource("global", paths)).toBe(paths.globalPath);
    expect(configPathForSource("runtime", paths)).toBeUndefined();
  });

  it("removing a global server touches only the global file, leaving project intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-panel-"));
    try {
      const home = path.join(dir, "home");
      const cwd = path.join(dir, "repo");
      const resolved = computeConfigPaths(home, cwd);
      mkdirSync(path.dirname(resolved.globalPath), { recursive: true });
      mkdirSync(path.dirname(resolved.projectPath), { recursive: true });
      writeFileSync(resolved.globalPath, applyServerToConfigText("", "km", { type: "http", url: "https://km" }), "utf8");
      writeFileSync(resolved.projectPath, applyServerToConfigText("", "github", { command: "npx" }), "utf8");

      // Simulate removeServerById's decision for a global-sourced server.
      const target = configPathForSource("global", resolved)!;
      expect(target).toBe(resolved.globalPath);
      writeFileSync(target, removeServerFromConfigText(readFileSync(target, "utf8"), "km"), "utf8");

      expect(parseMcpConfig(readFileSync(resolved.globalPath, "utf8")).servers).toEqual({});
      // project config must be untouched — this is exactly the bug that was fixed.
      expect(Object.keys(parseMcpConfig(readFileSync(resolved.projectPath, "utf8")).servers)).toEqual(["github"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runtime servers resolve to no file (never written to disk)", () => {
    expect(existsSync("/does-not-matter")).toBe(false);
    expect(configPathForSource("runtime", paths)).toBeUndefined();
  });
});
