// pi-plugin-loader-extension — discovers Claude-style plugins and wires their
// components into pi. This file is the ONLY place that touches the pi API, real
// fs, and disk writes; all decision logic lives in ./src pure functions.
//
// Wired now:
//   - skills/        → resources_discover skillPaths (pi reads foreign skill dirs natively)
//   - commands/*.md  → transformed to pi prompt templates written to a cache dir → promptPaths
//   - themes/        → resources_discover themePaths
//   - output-styles/ → applied on before_agent_start when one is selected (flag)
//   - mcpServers     → registered through Pi 1.0's native MCP server API
//
// Deferred (surfaced in /plugin + README): hooks/hooks.json and agents/*.md —
// these require a hooks-runner / subagent extension and are not hot-loadable via
// resources_discover.

import fs from "node:fs";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { isEnabled, reduceToggles, PLUGIN_TOGGLE_ENTRY } from "./src/config.js";
import { parsePluginCommand, PLUGIN_HELP } from "./src/cli.js";
import { PluginManager, type PluginScope } from "./src/manager.js";
import { PluginPanel, type PluginPanelDeps, type PluginRow } from "./src/panel.js";
import { transformCommand } from "./src/commandTransform.js";
import {
  commandFilesFor,
  deferredFor,
  mcpServerSourcePaths,
  skillPathsFor,
  outputStylePathsFor,
  agentPathsFor,
  themePathsFor,
} from "./src/contribute.js";
import { discoverManagedPlugins, discoverPlugins, type FsFacade } from "./src/discover.js";
import {
  buildMcpRegistrations,
  mergeServers,
  normalizeServersObject,
  reconcileMcpRegistrations,
  type McpRegistrar,
} from "./src/mcp.js";
import { buildSystemPrompt, parseOutputStyle, selectOutputStyle } from "./src/outputStyle.js";
import type { DiscoveredPlugin, EntryLike, OutputStyle } from "./src/types.js";

const ROOTS_FLAG = "plugin-dir";
const STYLE_FLAG = "plugin-output-style";
const STYLE_MODE_FLAG = "plugin-output-style-mode";

/** node:fs-backed facade passed into the pure discovery functions. */
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

/** Where transformed command prompts + collected styles are cached. */
function cacheRoot(): string {
  return join(os.homedir(), ".pi", "agent", "plugin-loader");
}

/** Default plugin roots: user home, then project-local. */
function defaultRoots(cwd: string): string[] {
  return [join(os.homedir(), ".pi", "agent", "plugins"), join(cwd, ".pi", "plugins")];
}

/** Extra roots from the --plugin-dir flag (comma-separated). */
function flagRoots(pi: ExtensionAPI, cwd: string): string[] {
  const raw = pi.getFlag(ROOTS_FLAG);
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (isAbsolute(s) ? s : resolve(cwd, s)));
}

/** List immediate *.md files under a dir (best-effort, one level). */
function listMarkdown(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function readFileSafe(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Reset + create a directory, returning it or undefined on failure. */
function freshDir(dir: string): string | undefined {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

interface Contribution {
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
  /** Names of commands written to the prompt cache (for /plugin list). */
  commandNames: string[];
  outputStyles: OutputStyle[];
  agentPaths: string[];
  hookPaths: string[];
  /** Unsupported features present in this plugin, for reporting. */
  deferred: string[];
}

/**
 * Materialize one enabled plugin's contributions to disk (prompt cache) and
 * collect the paths / styles pi needs. All fs writes happen here, not in src/.
 */
function contribute(plugin: DiscoveredPlugin): Contribution {
  const c: Contribution = {
    skillPaths: [],
    promptPaths: [],
    themePaths: [],
    commandNames: [],
    outputStyles: [],
    agentPaths: [],
    hookPaths: [],
    deferred: [],
  };
  const { dirs, root, name } = plugin;

  c.skillPaths.push(...skillPathsFor(dirs, root, plugin.manifest.skills));
  c.themePaths.push(...themePathsFor(dirs));
  c.agentPaths.push(...agentPathsFor(plugin));
  if (dirs.hooksJson) c.hookPaths.push(dirs.hooksJson);

  // Commands: transform each *.md and write to a per-plugin prompt cache dir.
  // The dir listing (fs) happens here; the dir + manifest source merge is pure.
  const dirMarkdown = dirs.commands ? listMarkdown(dirs.commands) : [];
  const commandFiles = commandFilesFor(plugin, dirMarkdown);

  if (commandFiles.length > 0) {
    const promptsDir = freshDir(join(cacheRoot(), name, "prompts"));
    if (promptsDir) {
      for (const file of commandFiles) {
        const source = readFileSafe(file);
        if (source === undefined) continue;
        const commandName = basename(file).replace(/\.md$/i, "");
        const out = transformCommand({
          pluginName: name,
          commandName,
          source,
          pluginRoot: root,
          sourcePath: file,
        });
        try {
          fs.writeFileSync(join(promptsDir, out.filename), out.content, "utf8");
          c.commandNames.push(`${name}_${commandName}`);
        } catch {
          // Drop this command silently; reported count reflects successes.
        }
      }
      if (c.commandNames.length > 0) c.promptPaths.push(promptsDir);
    }
  }

  // Output styles: convention + manifest-declared paths.
  for (const stylePath of outputStylePathsFor(dirs, root, plugin.manifest.outputStyles)) {
    const files = (() => {
      try { return fs.statSync(stylePath).isDirectory() ? listMarkdown(stylePath) : [stylePath]; }
      catch { return []; }
    })();
    for (const file of files) {
      const source = readFileSafe(file);
      if (source === undefined) continue;
      const id = basename(file).replace(/\.md$/i, "");
      const style = parseOutputStyle(id, source, root);
      style.plugin = name;
      c.outputStyles.push(style);
    }
  }

  // LSP has no dynamic registration surface in Pi yet. Hooks/agents are bridged below.
  c.deferred.push(...deferredFor({ ...dirs, hooksJson: undefined, agents: undefined }));

  return c;
}

/** Collect the merged MCP server record for a plugin (inline + .mcp.json + paths). */
function collectServers(plugin: DiscoveredPlugin): Record<string, unknown> {
  const sources: Record<string, unknown>[] = [];
  // Convention .mcp.json + manifest-declared paths first (lowest precedence),
  // in the order decided by the pure planner.
  for (const p of mcpServerSourcePaths(plugin)) {
    const text = readFileSafe(p);
    if (!text) continue;
    try {
      sources.push(normalizeServersObject(JSON.parse(text)));
    } catch {
      /* ignore malformed */
    }
  }
  // Inline manifest servers win (highest precedence).
  sources.push(normalizeServersObject(plugin.manifest.mcpServers.inline));
  return mergeServers(...sources);
}

export default function pluginLoaderExtension(pi: ExtensionAPI): void {
  const state: {
    plugins: DiscoveredPlugin[];
    toggles: Map<string, boolean>;
    contributions: Map<string, Contribution>;
    mcpServerNames: Set<string>;
  } = {
    plugins: [],
    toggles: new Map(),
    contributions: new Map(),
    mcpServerNames: new Set(),
  };

  pi.registerFlag(ROOTS_FLAG, {
    type: "string",
    description:
      "Extra plugin root directories to scan for Claude-style plugins (comma-separated).",
  });
  pi.registerFlag(STYLE_FLAG, {
    type: "string",
    description:
      "Name/id of a plugin output-style to apply to the system prompt each turn.",
  });
  pi.registerFlag(STYLE_MODE_FLAG, {
    type: "string",
    default: "append",
    description: "How a selected output-style is applied: append (default) | replace.",
  });

  let manager = new PluginManager();

  function enabled(): DiscoveredPlugin[] {
    return state.plugins.filter((p) => {
      const managed = manager.listInstalled().find((record) => resolve(record.path) === resolve(p.root));
      return isEnabled(p.name, state.toggles) && manager.isEnabled(managed?.id ?? p.name);
    });
  }

  function rediscover(cwd: string): void {
    manager = new PluginManager({ cwd });
    const managed = manager.listInstalled().filter((record) => fs.existsSync(record.path));
    const manual = discoverPlugins([...flagRoots(pi, cwd), ...defaultRoots(cwd)], realFs);
    const installed = discoverManagedPlugins(managed, realFs);
    const seenRoots = new Set<string>();
    state.plugins = [...installed, ...manual].filter((plugin) => {
      const root = resolve(plugin.root);
      if (seenRoots.has(root)) return false;
      seenRoots.add(root);
      return true;
    });
  }

  /** Build caches and reconcile every dynamically bridgeable plugin contribution. */
  function refreshContributions(ctx: ExtensionContext): void {
    state.contributions.clear();
    for (const plugin of enabled()) state.contributions.set(plugin.name, contribute(plugin));
    emitMcp(ctx);
    pi.events.emit("plugins:replace-agents", {
      paths: [...state.contributions.values()].flatMap((item) => item.agentPaths),
    });
    pi.events.emit("plugins:replace-hooks", {
      hooks: [...state.contributions.entries()].flatMap(([pluginName, item]) =>
        item.hookPaths.map((path) => {
          const record = manager.listInstalled().find((installed) => installed.name === pluginName);
          return {
            plugin: pluginName,
            path,
            root: record?.path ?? dirname(dirname(path)),
            data: record ? manager.pluginEnvironment(record).CLAUDE_PLUGIN_DATA : undefined,
            userConfig: record?.userConfig ?? {},
          };
        }),
      ),
    });
  }

  function emitMcp(ctx: ExtensionContext): void {
    const registrations = enabled().flatMap((plugin) => {
      const record = manager.listInstalled().find((installed) => resolve(installed.path) === resolve(plugin.root));
      const data = record ? manager.pluginEnvironment(record).CLAUDE_PLUGIN_DATA : "";
      return buildMcpRegistrations(plugin.name, collectServers(plugin), plugin.root, data);
    });
    const result = reconcileMcpRegistrations(
      pi as unknown as McpRegistrar,
      state.mcpServerNames,
      registrations,
    );
    state.mcpServerNames = result.registeredNames;
    for (const failure of result.errors) {
      ctx.ui.notify(
        `plugin-loader: failed to register MCP server "${failure.name}": ${failure.error}`,
        "warning",
      );
    }
  }

  pi.on("session_start", (_event, ctx): void => {
    const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    state.toggles = reduceToggles(branch);
    rediscover(ctx.cwd);
    refreshContributions(ctx);
  });

  pi.on("resources_discover", (event) => {
    // On reload, re-run discovery so newly added plugins are picked up.
    if (event.reason === "reload") {
      rediscover(event.cwd);
      refreshContributions(event as unknown as ExtensionContext);
    }
    const skillPaths: string[] = [];
    const promptPaths: string[] = [];
    const themePaths: string[] = [];
    for (const plugin of enabled()) {
      const c = state.contributions.get(plugin.name);
      if (!c) continue;
      skillPaths.push(...c.skillPaths);
      promptPaths.push(...c.promptPaths);
      themePaths.push(...c.themePaths);
    }
    return { skillPaths, promptPaths, themePaths };
  });

  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | void => {
      const selected = pi.getFlag(STYLE_FLAG);
      if (typeof selected !== "string" || !selected) return;
      const styles = enabled().flatMap((p) => state.contributions.get(p.name)?.outputStyles ?? []);
      const style = selectOutputStyle(styles, selected);
      if (!style) return;
      const modeRaw = pi.getFlag(STYLE_MODE_FLAG);
      const mode = modeRaw === "replace" ? "replace" : "append";
      return { systemPrompt: buildSystemPrompt(event.systemPrompt, style, mode) };
    },
  );

  function valueMap(pairs: string[]): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const pair of pairs) {
      const index = pair.indexOf("=");
      if (index < 1) throw new Error(`Expected key=value, got: ${pair}`);
      const raw = pair.slice(index + 1);
      try { values[pair.slice(0, index)] = JSON.parse(raw); }
      catch { values[pair.slice(0, index)] = raw; }
    }
    return values;
  }

  function formatList(available = false): unknown[] {
    if (available) return manager.listAvailable();
    const managed = manager.listInstalled();
    const managedNames = new Set(managed.map((item) => item.name));
    return [
      ...managed.map((item) => ({ ...item, enabled: manager.isEnabled(item.id) })),
      ...state.plugins.filter((item) => !managedNames.has(item.name)).map((item) => ({
        id: item.name, name: item.name, version: item.manifest.version ?? "", path: item.root,
        scope: "directory", enabled: enabled().some((plugin) => plugin.name === item.name),
      })),
    ];
  }

  /** Live deps for the PluginPanel overlay — every op delegates to `manager`. */
  function buildPanelDeps(): PluginPanelDeps {
    const marketplaceRows = () => {
      const avail = manager.listAvailable();
      return manager.listMarketplaces().map((m) => ({
        ...m,
        available: avail.filter((a) => a.marketplace === m.name).length,
        installed: avail.filter((a) => a.marketplace === m.name && a.installed).length,
      }));
    };
    return {
      listInstalled: () => formatList(false) as PluginRow[],
      listAvailable: () => manager.listAvailable(),
      listMarketplaces: marketplaceRows,
      componentsFor: (id) => manager.details(id).components,
      manifestFor: (id) => manager.details(id).manifest,
      setEnabled: (id, on, scope) => {
        // Mirror the /plugin enable|disable command branch: manager state +
        // session toggle entry (the latter gates directory plugins by name).
        manager.setEnabled(id, on, scope);
        state.toggles.set(id, on);
        pi.appendEntry(PLUGIN_TOGGLE_ENTRY, { name: id, enabled: on });
      },
      install: (id, scope, userConfig) => void manager.install(id, scope, { userConfig }),
      uninstall: (id, scope, opts) => void manager.uninstall(id, scope, opts),
      update: (id, scope) => void manager.update(id, scope),
      configure: (id, values, scope) => void manager.configure(id, values, scope),
      addMarketplace: (source, scope) => void manager.addMarketplace(source, scope),
      removeMarketplace: (name, scope) => void manager.removeMarketplace(name, scope),
      updateMarketplace: (name) => void manager.updateMarketplace(name),
    };
  }

  /** Open the Claude-style capturing overlay; reconcile once on dirty close. */
  async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
    const deps = buildPanelDeps();
    let panel: PluginPanel | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          panel = new PluginPanel(theme, deps, done);
          panel.requestRender = () => tui.requestRender();
          unsubscribe = tui.addInputListener((data) => {
            panel?.handleInput(data);
            return { consume: true };
          });
          return panel;
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", margin: 1 } },
      );
    } finally {
      unsubscribe?.();
    }
    if (panel?.dirty) {
      rediscover(ctx.cwd);
      refreshContributions(ctx);
      ctx.ui.notify(
        "Run /reload to apply skills, commands, hooks, and agents; restart may be required for MCP/LSP processes.",
        "info",
      );
    }
  }

  pi.registerCommand("plugin", {
    description: "Manage Claude-style plugins and marketplaces.",
    async handler(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
      try {
        const args = rawArgs.trim();
        // No-args + interactive terminal → open the overlay panel. Headless
        // (scripts/tests) with no args falls through to a plain `list`.
        if (!args && ctx.hasUI) {
          await openPanel(ctx);
          return;
        }
        const selected = args || "list";
        const parsed = parsePluginCommand(selected);
        const sub = parsed.command || "list";
        const scope = parsed.scope ?? "user";
        let result: unknown;

        if (sub === "help" || sub === "--help" || sub === "-h") {
          ctx.ui.notify(PLUGIN_HELP, "info");
          return;
        } else if (sub === "list") {
          result = formatList(parsed.available);
        } else if (sub === "marketplace") {
          const action = parsed.args[0];
          const target = parsed.args[1];
          if (action === "add" && target) result = manager.addMarketplace(target, scope);
          else if (action === "list") result = manager.listMarketplaces(parsed.scope);
          else if ((action === "remove" || action === "rm") && target) result = { removed: manager.removeMarketplace(target, parsed.scope) };
          else if (action === "update") result = manager.updateMarketplace(target);
          else throw new Error("Usage: /plugin marketplace add|list|remove|update ...");
        } else if (sub === "install" || sub === "i") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin install <plugin@marketplace> [--scope ...]");
          result = manager.install(parsed.args[0], scope, { userConfig: parsed.configs });
        } else if (sub === "uninstall" || sub === "remove") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin uninstall <plugin> [--scope ...]");
          result = manager.uninstall(parsed.args[0], scope, { keepData: parsed.keepData, prune: parsed.prune });
        } else if (sub === "enable" || sub === "disable") {
          const on = sub === "enable";
          if (parsed.all) result = manager.listInstalled(parsed.scope).map((item) => manager.setEnabled(item.id, on, item.scope));
          else {
            const target = parsed.args[0];
            if (!target) throw new Error(`Usage: /plugin ${sub} <plugin> [--scope ...]`);
            result = manager.setEnabled(target, on, parsed.scope);
            state.toggles.set(target, on);
            pi.appendEntry(PLUGIN_TOGGLE_ENTRY, { name: target, enabled: on });
          }
        } else if (sub === "update") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin update <plugin> [--scope ...]");
          result = manager.update(parsed.args[0], scope);
        } else if (sub === "details") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin details <plugin>");
          result = manager.details(parsed.args[0]);
        } else if (sub === "configure") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin configure <plugin> key=value ...");
          result = manager.configure(parsed.args[0], { ...valueMap(parsed.args.slice(1)), ...parsed.configs }, parsed.scope);
        } else if (sub === "validate") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin validate <path>");
          result = manager.validate(parsed.args[0]);
        } else if (sub === "init" || sub === "new") {
          if (!parsed.args[0]) throw new Error("Usage: /plugin init <name> [parent-directory]");
          result = { path: manager.init(parsed.args[0], parsed.args[1]) };
        } else if (sub === "prune" || sub === "autoremove") {
          result = manager.prune(scope);
        } else throw new Error(`Unknown plugin command: ${sub}. Run /plugin help.`);

        rediscover(ctx.cwd);
        refreshContributions(ctx);
        const text = parsed.json ? JSON.stringify(result, null, 2) : Array.isArray(result)
          ? (result.length ? result.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") : "No plugins found.")
          : typeof result === "string" ? result : JSON.stringify(result, null, 2);
        ctx.ui.notify(`${text}\n\nRun /reload to refresh skills, commands, hooks, and agents; restart may be required for MCP/LSP processes.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
