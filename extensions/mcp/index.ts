// pi-mcp-extension — a self-contained MCP client. index.ts owns all pi API
// interaction and all side effects (file I/O, spawning transports, network);
// every decision helper lives in src/ as a pure/injectable module.
//
// Flow: session_start → read ~/.pi/agent/mcp.json + <cwd>/.pi/mcp.json
// (falling back to compatible .mcp.json paths) → parse + merge (project wins)
// → per server createTransport → McpClient
// .initialize() → listTools() → buildToolDefinitions() → pi.registerTool.
// Each tool's execute forwards to the live client and maps MCP content back to
// a pi tool result. Failures degrade per-server (notify + status=error); they
// never throw or block other servers or startup.
//
// Approval is NOT handled here: the approvals extension's tool_call gate already
// recognizes the mcp__ prefix. plugin-loader can inject servers at runtime via
// the pi.events "mcp:register-server" channel.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import {
  parseMcpConfig,
  mergeMcpConfigs,
  computeConfigPaths,
  configPathForSource,
  normalizeServerConfig,
  applyServerToConfigText,
  removeServerFromConfigText,
} from "./src/config.js";
import { createTransport } from "./src/transport.js";
import { McpClient } from "./src/client.js";
import { buildToolDefinitions } from "./src/register.js";
import { sanitizeServerName } from "./src/naming.js";
import { mcpContentToToolResult } from "./src/result.js";
import { renderMcpCall, renderMcpResult } from "./src/render.js";
import {
  McpPanel,
  parseKvPairs,
  type McpPanelDeps,
  type McpServerRow,
  type RemoveResult,
  type Transport as PanelTransport,
  type Scope as PanelScope,
} from "./src/panel.js";
import type {
  McpServerConfig,
  McpStdioConfig,
  McpHttpConfig,
  McpToolDef,
  Transport,
  ServerSource,
  McpRegistration,
} from "./src/types.js";

interface RegistryEntry {
  /**
   * Canonical, sanitized server id. This is the registry key, the segment used
   * in every `mcp__<name>__<tool>` tool name, the dispatch key resolved at call
   * time, and what the approvals gate matches on — a single id threaded through
   * the whole pipeline so it is always OpenAI-legal.
   */
  name: string;
  /**
   * The original (pre-sanitization) server name as declared in config or by
   * plugin-loader. Used only for display and for locating the entry in the
   * on-disk config file (which stores raw names) — never for tool names.
   */
  rawName: string;
  config: McpServerConfig;
  source: ServerSource;
  transport?: Transport;
  client?: McpClient;
  tools: McpToolDef[];
  status: "connected" | "error" | "disconnected";
  error?: string;
}

interface McpToolDetails {
  server: string;
  tool: string;
  isError: boolean;
}

const REGISTER_CHANNEL = "mcp:register-server";

export default function mcpExtension(pi: ExtensionAPI): void {
  const registry = new Map<string, RegistryEntry>();
  const registeredToolNames = new Set<string>();
  let lastUi: ExtensionUIContext | undefined;
  let projectConfigPath = "";
  let globalConfigPath = "";
  let initialized = false;

  const notify = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      lastUi?.notify(msg, type);
    } catch {
      // notify must never throw
    }
  };

  // Resolve a raw server name to its canonical (sanitized) registry id. If this
  // raw name is already registered, reuse its existing id so reconnects and
  // config edits stay stable; otherwise sanitize it and, on collision with an
  // already-taken id, append a numeric suffix. The canonical id — not the raw
  // name — is the registry key and the segment used in every tool name.
  const canonicalIdFor = (rawName: string): string => {
    for (const [id, entry] of registry) {
      if (entry.rawName === rawName) return id;
    }
    return sanitizeServerName(rawName, new Set(registry.keys()));
  };

  const connectedCount = (): number => {
    let n = 0;
    for (const e of registry.values()) if (e.status === "connected") n += 1;
    return n;
  };

  const refreshStatus = (): void => {
    try {
      lastUi?.setStatus("mcp", `MCP: ${connectedCount()} server(s)`);
    } catch {
      // ignore
    }
  };

  // Register a tool exactly once. execute resolves the *live* client from the
  // registry at call time, so reconnecting a server keeps its tools working
  // without re-registration (pi has no unregisterTool).
  const registerToolOnce = (server: string, tool: McpToolDef): void => {
    const [spec] = buildToolDefinitions(server, [tool]);
    if (registeredToolNames.has(spec.name)) return;
    registeredToolNames.add(spec.name);
    pi.registerTool<typeof spec.parameters, McpToolDetails>({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      // Opt this tool into the system prompt's `Available tools` section.
      //
      // Pi only lists a custom tool there when `promptSnippet` is set. Without
      // it MCP tools are registered and callable but *invisible*: the model has
      // no way to learn they exist, so it must guess names and tends to
      // conclude the capability is missing. Observed for real — an agent probed
      // only read-only MCP tools, then reported the write/generation tools as
      // absent while all 14 were registered.
      promptSnippet: spec.promptSnippet,
      executionMode: "parallel",
      // Self-render like claude-ui's native overrides — no default bg Box —
      // with a `● server:tool(args)` head and a `⎿` result that folds when
      // collapsed (Ctrl+O expands), same as the built-in tools.
      renderShell: "self",
      renderCall(args, theme, context) {
        const state =
          context?.isPartial !== false
            ? "pending"
            : context.isError
              ? "error"
              : "success";
        return renderMcpCall(spec.label, args, theme, state);
      },
      renderResult(result, options, theme, context) {
        return renderMcpResult(
          result,
          {
            expanded: options.expanded,
            isPartial: options.isPartial,
            isError: context?.isError,
          },
          theme,
        );
      },
      async execute(_toolCallId, params) {
        const entry = registry.get(server);
        const client = entry?.client;
        if (!client) {
          return {
            content: [
              { type: "text", text: `MCP server "${server}" is not connected.` },
            ] as (TextContent | ImageContent)[],
            details: { server, tool: spec.toolName, isError: true },
          };
        }
        try {
          const { content, isError } = await client.callTool(spec.toolName, params);
          const mapped = mcpContentToToolResult(
            content,
            { truncateHead, maxBytes: DEFAULT_MAX_BYTES },
            isError,
          );
          return {
            content: mapped.content,
            details: { server, tool: spec.toolName, isError: mapped.isError },
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `MCP call failed: ${(err as Error).message}` },
            ] as (TextContent | ImageContent)[],
            details: { server, tool: spec.toolName, isError: true },
          };
        }
      },
    });
  };

  // Connect (or reconnect) one server. Never throws.
  const connect = async (entry: RegistryEntry): Promise<void> => {
    // Tear down any previous transport before reconnecting.
    if (entry.transport) {
      try {
        entry.transport.close();
      } catch {
        // ignore
      }
      entry.transport = undefined;
      entry.client = undefined;
    }
    try {
      const transport = createTransport(entry.config);
      const client = new McpClient(transport);
      await client.initialize();
      const tools = await client.listTools();
      entry.transport = transport;
      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.error = undefined;
      for (const tool of tools) registerToolOnce(entry.name, tool);
    } catch (err) {
      entry.status = "error";
      entry.error = (err as Error).message;
      if (entry.transport) {
        try {
          entry.transport.close();
        } catch {
          // ignore
        }
        entry.transport = undefined;
      }
      entry.client = undefined;
      notify(`MCP server "${entry.rawName}" failed: ${entry.error}`, "error");
    }
  };

  const readFileSafe = (p: string): string => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {
      return "";
    }
  };

  const loadAndConnectAll = async (cwd: string): Promise<void> => {
    const home = os.homedir();
    const paths = computeConfigPaths(home, cwd);
    projectConfigPath = paths.projectPath;
    globalConfigPath = paths.globalPath;

    const globalCanonical = readFileSafe(paths.globalPath);
    const projectCanonical = readFileSafe(paths.projectPath);
    const g = parseMcpConfig(
      globalCanonical.trim() ? globalCanonical : readFileSafe(paths.legacyGlobalPath),
    );
    const p = parseMcpConfig(
      projectCanonical.trim() ? projectCanonical : readFileSafe(paths.legacyProjectPath),
    );
    for (const e of [...g.errors, ...p.errors]) notify(`MCP config: ${e}`, "warning");

    const merged = mergeMcpConfigs(g.servers, p.servers);
    for (const { name, config, source } of Object.values(merged)) {
      const id = canonicalIdFor(name);
      if (!registry.has(id)) {
        registry.set(id, { name: id, rawName: name, config, source, tools: [], status: "disconnected" });
      }
    }
    await Promise.all(
      [...registry.values()]
        .filter((e) => e.status === "disconnected")
        .map((e) => connect(e)),
    );
    refreshStatus();
  };

  // ---- session lifecycle ----

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    lastUi = ctx.ui;
    if (initialized) {
      refreshStatus();
      return;
    }
    initialized = true;
    await loadAndConnectAll(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    await Promise.all(
      [...registry.values()].map(
        (e) =>
          new Promise<void>((resolve) => {
            try {
              e.transport?.close();
            } catch {
              // ignore
            }
            e.transport = undefined;
            e.client = undefined;
            e.status = "disconnected";
            resolve();
          }),
      ),
    );
  });

  // ---- runtime injection from plugin-loader ----

  pi.events.on("mcp:replace-plugin-servers", (payload: unknown) => {
    const items = payload && typeof payload === "object" && Array.isArray((payload as { registrations?: unknown }).registrations)
      ? (payload as { registrations: unknown[] }).registrations
      : [];
    const wanted = new Set(items.flatMap((item) => {
      const name = item && typeof item === "object" ? (item as { name?: unknown }).name : undefined;
      return typeof name === "string" ? [name] : [];
    }));
    // The registry is keyed by sanitized canonical id, but the payload carries
    // raw (pre-sanitized) names, so match on each entry's rawName throughout.
    for (const [id, entry] of [...registry.entries()]) {
      if (entry.source !== "runtime" || wanted.has(entry.rawName)) continue;
      registry.delete(id);
      // Pi cannot unregister tools; close the old transport. Re-adding this name registers a fresh tool/client.
      entry.transport?.close();
    }
    // Force re-registration on same-name config changes instead of silently retaining stale config.
    for (const [id, entry] of [...registry.entries()]) {
      if (entry.source !== "runtime" || !wanted.has(entry.rawName)) continue;
      registry.delete(id);
      entry.transport?.close();
    }
    refreshStatus();
  });

  pi.events.on(REGISTER_CHANNEL, (data: unknown) => {
    const reg = data as Partial<McpRegistration> | null;
    if (!reg || typeof reg.name !== "string" || reg.name.length === 0) {
      notify("mcp:register-server ignored: missing name", "warning");
      return;
    }
    const config = normalizeServerConfig(reg.config);
    if (!config) {
      notify(`mcp:register-server "${reg.name}" ignored: invalid config`, "warning");
      return;
    }
    const id = canonicalIdFor(reg.name);
    const entry: RegistryEntry = {
      name: id,
      rawName: reg.name,
      config,
      source: "runtime",
      tools: [],
      status: "disconnected",
    };
    registry.set(id, entry);
    void connect(entry).then(() => refreshStatus());
  });

  // ---- /mcp command ----

  const buildListText = (): string => {
    if (registry.size === 0) return "No MCP servers configured.";
    const lines: string[] = [];
    for (const e of registry.values()) {
      const kind = "command" in e.config ? "stdio" : (e.config as { type: string }).type;
      const detail =
        e.status === "connected"
          ? `${e.tools.length} tool(s)`
          : e.status === "error"
            ? `error: ${e.error ?? "unknown"}`
            : "disconnected";
      lines.push(`• ${e.rawName} [${e.source}/${kind}] — ${e.status}, ${detail}`);
    }
    lines.push(`(${connectedCount()} connected)`);
    return lines.join("\n");
  };

  // Generalized config writer: write to an arbitrary path (project or global),
  // so add/remove can target the file that actually owns the server.
  const writeConfigAt = (targetPath: string, mutate: (text: string) => string): boolean => {
    try {
      const current = readFileSafe(targetPath);
      const next = mutate(current);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, next, "utf8");
      return true;
    } catch (err) {
      notify(`Failed to write ${targetPath}: ${(err as Error).message}`, "error");
      return false;
    }
  };

  // The on-disk config file that owns a server of the given source. Runtime
  // (plugin-injected) servers have no config file — never write for them.
  const pathForSource = (source: ServerSource): string | undefined =>
    configPathForSource(source, { projectPath: projectConfigPath, globalPath: globalConfigPath });

  // Project a live registry entry into the plain row the panel renders from.
  const toServerRow = (entry: RegistryEntry): McpServerRow => {
    const cfg = entry.config;
    const isStdio = "command" in cfg;
    const transport: PanelTransport = isStdio ? "stdio" : (cfg as McpHttpConfig).type;
    const row: McpServerRow = {
      id: entry.name,
      rawName: entry.rawName,
      transport,
      source: entry.source,
      status: entry.status,
      error: entry.error,
      toolCount: entry.tools.length,
    };
    if (isStdio) {
      const c = cfg as McpStdioConfig;
      row.command = c.command;
      row.args = c.args;
      row.env = c.env;
    } else {
      const c = cfg as McpHttpConfig;
      row.url = c.url;
      row.headers = c.headers;
    }
    return row;
  };

  // Shared remove path used by both the panel and the /mcp remove subcommand.
  // Writes to the correct file by source; runtime servers are memory-only.
  const removeServerById = (id: string): RemoveResult => {
    const entry = registry.get(id);
    if (!entry) return { removedFromFile: false, message: "Server not found." };
    const targetPath = pathForSource(entry.source);
    let removedFromFile = false;
    if (targetPath) {
      removedFromFile = writeConfigAt(targetPath, (t) => removeServerFromConfigText(t, entry.rawName));
    }
    try {
      entry.transport?.close();
    } catch {
      // ignore
    }
    registry.delete(id);
    refreshStatus();
    const message =
      entry.source === "runtime"
        ? `"${entry.rawName}" comes from a plugin; removed from memory only (returns on reload). Disable the plugin via /plugin.`
        : `Removed "${entry.rawName}" from ${targetPath}. Its tools stay registered until restart.`;
    return { removedFromFile, message };
  };

  // Everything the McpPanel overlay needs, bound to this extension's registry.
  const buildPanelDeps = (): McpPanelDeps => ({
    listServers: () => [...registry.values()].map(toServerRow),
    toolsFor: (id) => registry.get(id)?.tools ?? [],
    configPaths: () => ({ projectPath: projectConfigPath, globalPath: globalConfigPath }),
    reconnect: async (id) => {
      const entry = registry.get(id);
      if (!entry) return;
      await connect(entry);
      refreshStatus();
    },
    addServer: async ({ name, scope, config }) => {
      const target = scope === "global" ? globalConfigPath : projectConfigPath;
      if (!writeConfigAt(target, (t) => applyServerToConfigText(t, name, config))) {
        return { status: "error", error: `failed to write ${target}` };
      }
      const id = canonicalIdFor(name);
      const entry: RegistryEntry = { name: id, rawName: name, config, source: scope, tools: [], status: "disconnected" };
      registry.set(id, entry);
      await connect(entry);
      refreshStatus();
      return { status: entry.status, error: entry.error };
    },
    removeServer: (id) => removeServerById(id),
  });

  const openPanel = async (ctx: ExtensionContext): Promise<void> => {
    const deps = buildPanelDeps();
    let panel: McpPanel | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          panel = new McpPanel(theme, deps, done);
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
    refreshStatus();
  };

  const handleAdd = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify("/mcp add requires interactive UI", "warning");
      return;
    }
    const kind = await ctx.ui.select("MCP server type", ["stdio", "http", "sse"]);
    if (!kind) return;
    const scopeChoice = await ctx.ui.select("Scope", ["project", "global"]);
    if (!scopeChoice) return;
    const scope = scopeChoice as PanelScope;
    const name = await ctx.ui.input("Server name", "e.g. github");
    if (!name) return;

    let config: McpServerConfig | undefined;
    if (kind === "stdio") {
      const command = await ctx.ui.input("Command", "e.g. npx");
      if (!command) return;
      const argsRaw = await ctx.ui.input("Args (space-separated, optional)", "");
      const envRaw = await ctx.ui.input("Env (KEY=value, comma-separated, optional)", "");
      config = { command, ...(argsRaw ? { args: argsRaw.split(/\s+/).filter(Boolean) } : {}) };
      const env = parseKvPairs(envRaw ?? "");
      if (Object.keys(env).length) (config as McpStdioConfig).env = env;
    } else {
      const url = await ctx.ui.input("URL", "https://…");
      if (!url) return;
      const headersRaw = await ctx.ui.input("Headers (KEY=value, comma-separated, optional)", "");
      config = { type: kind as "http" | "sse", url };
      const headers = parseKvPairs(headersRaw ?? "");
      if (Object.keys(headers).length) (config as McpHttpConfig).headers = headers;
    }

    const target = scope === "global" ? globalConfigPath : projectConfigPath;
    if (!writeConfigAt(target, (text) => applyServerToConfigText(text, name, config!))) return;
    const id = canonicalIdFor(name);
    const entry: RegistryEntry = {
      name: id,
      rawName: name,
      config,
      source: scope,
      tools: [],
      status: "disconnected",
    };
    registry.set(id, entry);
    await connect(entry);
    refreshStatus();
    notify(
      `Added MCP server "${name}" to ${scope} (${entry.status}).`,
      entry.status === "connected" ? "info" : "warning",
    );
  };

  const handleRemove = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify("/mcp remove requires interactive UI", "warning");
      return;
    }
    const entries = [...registry.values()];
    if (entries.length === 0) {
      notify("No MCP servers to remove.", "info");
      return;
    }
    // Present the raw names (what appears in the config file), then resolve back
    // to the canonical registry id — removeServerById writes the correct file
    // by source (project/global) and never touches disk for runtime servers.
    const rawNames = entries.map((e) => e.rawName);
    const chosen = await ctx.ui.select("Remove which MCP server?", rawNames);
    if (!chosen) return;
    const entry = entries.find((e) => e.rawName === chosen);
    if (!entry) return;
    const res = removeServerById(entry.name);
    notify(res.message, "info");
  };

  const handleReconnect = async (target?: string): Promise<void> => {
    const entries = [...registry.values()];
    const chosen = target
      ? entries.filter((e) => e.rawName === target || e.name === target)
      : entries;
    if (target && chosen.length === 0) {
      notify(`No MCP server named "${target}".`, "warning");
      return;
    }
    await Promise.all(chosen.map((e) => connect(e)));
    refreshStatus();
    notify(
      `Reconnected ${target ? `"${target}"` : "MCP servers"} (${connectedCount()} connected).`,
      "info",
    );
  };

  pi.registerCommand("mcp", {
    description: "Manage MCP servers: list | status | add | remove | reconnect",
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "";
      switch (sub) {
        case "":
          // Interactive terminal → open the overlay panel; headless → list text.
          if (ctx.hasUI) {
            await openPanel(ctx);
          } else {
            notify(buildListText(), "info");
          }
          return;
        case "list":
        case "status":
          notify(buildListText(), "info");
          return;
        case "add":
          await handleAdd(ctx);
          return;
        case "remove":
          await handleRemove(ctx);
          return;
        case "reconnect":
          await handleReconnect(parts[1]);
          return;
        default:
          notify(`Unknown /mcp subcommand "${sub}". Use list|status|add|remove|reconnect.`, "warning");
      }
    },
  });
}
