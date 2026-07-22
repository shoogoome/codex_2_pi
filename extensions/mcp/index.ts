// pi-mcp-extension — a self-contained MCP client. index.ts owns all pi API
// interaction and all side effects (file I/O, spawning transports, network);
// every decision helper lives in src/ as a pure/injectable module.
//
// Flow: session_start → read ~/.pi/agent/mcp.json + <cwd>/.pi/mcp.json →
// parse + merge (project wins) → per server createTransport → McpClient
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
  normalizeServerConfig,
  applyServerToConfigText,
  removeServerFromConfigText,
} from "./src/config.js";
import { createTransport } from "./src/transport.js";
import { McpClient } from "./src/client.js";
import { buildToolDefinitions } from "./src/register.js";
import { mcpContentToToolResult } from "./src/result.js";
import type {
  McpServerConfig,
  McpToolDef,
  Transport,
  ServerSource,
  McpRegistration,
} from "./src/types.js";

interface RegistryEntry {
  name: string;
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
  let initialized = false;

  const notify = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      lastUi?.notify(msg, type);
    } catch {
      // notify must never throw
    }
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
      executionMode: "parallel",
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
      notify(`MCP server "${entry.name}" failed: ${entry.error}`, "error");
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

    const g = parseMcpConfig(readFileSafe(paths.globalPath));
    const p = parseMcpConfig(readFileSafe(paths.projectPath));
    for (const e of [...g.errors, ...p.errors]) notify(`MCP config: ${e}`, "warning");

    const merged = mergeMcpConfigs(g.servers, p.servers);
    for (const { name, config, source } of Object.values(merged)) {
      if (!registry.has(name)) {
        registry.set(name, { name, config, source, tools: [], status: "disconnected" });
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
    const entry: RegistryEntry = {
      name: reg.name,
      config,
      source: "runtime",
      tools: [],
      status: "disconnected",
    };
    registry.set(reg.name, entry);
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
      lines.push(`• ${e.name} [${e.source}/${kind}] — ${e.status}, ${detail}`);
    }
    lines.push(`(${connectedCount()} connected)`);
    return lines.join("\n");
  };

  const writeProjectConfig = (mutate: (text: string) => string): boolean => {
    try {
      const current = readFileSafe(projectConfigPath);
      const next = mutate(current);
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(projectConfigPath, next, "utf8");
      return true;
    } catch (err) {
      notify(`Failed to write ${projectConfigPath}: ${(err as Error).message}`, "error");
      return false;
    }
  };

  const handleAdd = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify("/mcp add requires interactive UI", "warning");
      return;
    }
    const kind = await ctx.ui.select("MCP server type", ["stdio", "http", "sse"]);
    if (!kind) return;
    const name = await ctx.ui.input("Server name", "e.g. github");
    if (!name) return;

    let config: McpServerConfig | undefined;
    if (kind === "stdio") {
      const command = await ctx.ui.input("Command", "e.g. npx");
      if (!command) return;
      const argsRaw = await ctx.ui.input("Args (space-separated, optional)", "");
      config = { command, ...(argsRaw ? { args: argsRaw.split(/\s+/).filter(Boolean) } : {}) };
    } else {
      const url = await ctx.ui.input("URL", "https://…");
      if (!url) return;
      config = { type: kind as "http" | "sse", url };
    }

    if (!writeProjectConfig((text) => applyServerToConfigText(text, name, config!))) return;
    const entry: RegistryEntry = {
      name,
      config,
      source: "project",
      tools: [],
      status: "disconnected",
    };
    registry.set(name, entry);
    await connect(entry);
    refreshStatus();
    notify(`Added MCP server "${name}" (${entry.status}).`, entry.status === "connected" ? "info" : "warning");
  };

  const handleRemove = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify("/mcp remove requires interactive UI", "warning");
      return;
    }
    const names = [...registry.keys()];
    if (names.length === 0) {
      notify("No MCP servers to remove.", "info");
      return;
    }
    const name = await ctx.ui.select("Remove which MCP server?", names);
    if (!name) return;
    writeProjectConfig((text) => removeServerFromConfigText(text, name));
    const entry = registry.get(name);
    try {
      entry?.transport?.close();
    } catch {
      // ignore
    }
    registry.delete(name);
    refreshStatus();
    notify(
      `Removed "${name}" from config. Its tools remain registered until restart.`,
      "info",
    );
  };

  const handleReconnect = async (): Promise<void> => {
    await Promise.all([...registry.values()].map((e) => connect(e)));
    refreshStatus();
    notify(`Reconnected MCP servers (${connectedCount()} connected).`, "info");
  };

  pi.registerCommand("mcp", {
    description: "Manage MCP servers: list | status | add | remove | reconnect",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      switch (sub) {
        case "":
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
          await handleReconnect();
          return;
        default:
          notify(`Unknown /mcp subcommand "${sub}". Use list|status|add|remove|reconnect.`, "warning");
      }
    },
  });
}
