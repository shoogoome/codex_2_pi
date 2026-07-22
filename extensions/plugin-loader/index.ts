// pi-plugin-loader-extension — discovers Claude-style plugins and wires their
// components into pi. This file is the ONLY place that touches the pi API, real
// fs, and disk writes; all decision logic lives in ./src pure functions.
//
// Wired now:
//   - skills/        → resources_discover skillPaths (pi reads foreign skill dirs natively)
//   - commands/*.md  → transformed to pi prompt templates written to a cache dir → promptPaths
//   - themes/        → resources_discover themePaths
//   - output-styles/ → applied on before_agent_start when one is selected (flag)
//   - mcpServers     → emitted per server on the mcp:register-server bus channel
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
import { transformCommand } from "./src/commandTransform.js";
import {
  commandFilesFor,
  deferredFor,
  mcpServerSourcePaths,
  skillPathsFor,
  themePathsFor,
} from "./src/contribute.js";
import { discoverPlugins, type FsFacade } from "./src/discover.js";
import {
  buildMcpRegistrations,
  detectMcpExtension,
  mergeServers,
  normalizeServersObject,
  MCP_REGISTER_CHANNEL,
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
  /** Deferred features present in this plugin, for reporting. */
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
    deferred: [],
  };
  const { dirs, root, name } = plugin;

  c.skillPaths.push(...skillPathsFor(dirs));
  c.themePaths.push(...themePathsFor(dirs));

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

  // Output styles: parse + collect (applied later on before_agent_start).
  if (dirs.outputStyles) {
    for (const file of listMarkdown(dirs.outputStyles)) {
      const source = readFileSafe(file);
      if (source === undefined) continue;
      const id = basename(file).replace(/\.md$/i, "");
      const style = parseOutputStyle(id, source, root);
      style.plugin = name;
      c.outputStyles.push(style);
    }
  }

  // Deferred features — reported, not wired.
  c.deferred.push(...deferredFor(dirs));

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
    mcpNotified: boolean;
  } = {
    plugins: [],
    toggles: new Map(),
    contributions: new Map(),
    mcpNotified: false,
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

  function enabled(): DiscoveredPlugin[] {
    return state.plugins.filter((p) => isEnabled(p.name, state.toggles));
  }

  function rediscover(cwd: string): void {
    const roots = [...flagRoots(pi, cwd), ...defaultRoots(cwd)];
    state.plugins = discoverPlugins(roots, realFs);
  }

  /** Build the prompt cache + emit mcp registrations for all enabled plugins. */
  function refreshContributions(ctx: ExtensionContext): void {
    state.contributions.clear();
    for (const plugin of enabled()) {
      state.contributions.set(plugin.name, contribute(plugin));
    }
    emitMcp(ctx);
  }

  function emitMcp(ctx: ExtensionContext): void {
    const registrations = enabled().flatMap((plugin) =>
      buildMcpRegistrations(plugin.name, collectServers(plugin), plugin.root),
    );
    if (registrations.length === 0) return;
    for (const reg of registrations) {
      pi.events.emit(MCP_REGISTER_CHANNEL, reg);
    }
    if (!detectMcpExtension(pi.getCommands()) && !state.mcpNotified) {
      state.mcpNotified = true;
      ctx.ui.notify(
        `plugin-loader: ${registrations.length} MCP server(s) declared by plugins, but no mcp ` +
          `extension appears installed. Install/enable the mcp extension to activate them.`,
        "warning",
      );
    }
  }

  pi.on("session_start", (_event, ctx): void => {
    const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    state.toggles = reduceToggles(branch);
    state.mcpNotified = false;
    rediscover(ctx.cwd);
    refreshContributions(ctx);
  });

  pi.on("resources_discover", (event) => {
    // On reload, re-run discovery so newly added plugins are picked up.
    if (event.reason === "reload") {
      rediscover(event.cwd);
      state.contributions.clear();
      for (const plugin of enabled()) {
        state.contributions.set(plugin.name, contribute(plugin));
      }
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

  pi.registerCommand("plugin", {
    description: "List discovered plugins and enable/disable them.",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = parts[0];
      const target = parts.slice(1).join(" ").trim();

      if (!sub || sub === "list") {
        if (state.plugins.length === 0) {
          ctx.ui.notify(
            "No plugins discovered. Drop a plugin under ~/.pi/agent/plugins/, .pi/plugins/, " +
              "or pass --plugin-dir <dir>.",
            "info",
          );
          return;
        }
        const lines: string[] = [];
        for (const plugin of state.plugins) {
          const on = isEnabled(plugin.name, state.toggles);
          const c = state.contributions.get(plugin.name);
          const bits: string[] = [];
          if (c?.skillPaths.length) bits.push("skills");
          if (c?.commandNames.length) bits.push(`commands(${c.commandNames.length})`);
          if (c?.themePaths.length) bits.push("themes");
          if (c?.outputStyles.length) bits.push(`output-styles(${c.outputStyles.length})`);
          const servers = Object.keys(collectServers(plugin));
          if (servers.length) bits.push(`mcp(${servers.length})`);
          const deferred = c?.deferred.length ? ` — deferred: ${c.deferred.join(", ")}` : "";
          const contributes = bits.length ? bits.join(", ") : "nothing";
          lines.push(
            `${on ? "[on] " : "[off]"} ${plugin.name}${plugin.manifest.version ? ` v${plugin.manifest.version}` : ""} — ${contributes}${deferred}`,
          );
        }
        lines.push("");
        lines.push(
          "Deferred features (hooks, agents) need a hooks-runner / subagent extension — not loaded yet.",
        );
        lines.push("Use /plugin enable <name> · /plugin disable <name>. Reload to apply.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "enable" || sub === "disable") {
        if (!target) {
          ctx.ui.notify(`Usage: /plugin ${sub} <plugin-name>.`, "error");
          return;
        }
        const known = state.plugins.some((p) => p.name === target);
        if (!known) {
          ctx.ui.notify(`Unknown plugin "${target}". Use /plugin list.`, "error");
          return;
        }
        const nextEnabled = sub === "enable";
        state.toggles.set(target, nextEnabled);
        pi.appendEntry(PLUGIN_TOGGLE_ENTRY, { name: target, enabled: nextEnabled });
        ctx.ui.notify(
          `Plugin "${target}" ${nextEnabled ? "enabled" : "disabled"}. Run /reload to apply resource changes.`,
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown subcommand "${sub}". Use: list, enable, disable.`, "error");
    },
  });
}
