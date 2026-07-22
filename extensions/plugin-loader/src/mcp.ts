// Pure builders for mcp:register-server payloads handed to the mcp extension.
//
// A plugin declares MCP servers either inline in its manifest (normalized into a
// { serverName: config } record by manifest.ts) and/or via a `.mcp.json` file.
// This module normalizes a parsed servers object, merges sources, substitutes
// CLAUDE_PLUGIN_ROOT, and namespaces each server as `${plugin}:${server}`.

import { substituteDeep } from "./vars.js";
import type { McpRegistration } from "./types.js";

/** Channel the mcp extension listens on. */
export const MCP_REGISTER_CHANNEL = "mcp:register-server";

/**
 * Normalize a parsed JSON object into a `{ serverName: config }` record.
 * Accepts either a top-level `{ mcpServers: {...} }` wrapper (the `.mcp.json`
 * convention) or a bare record of server configs. Non-object server values are
 * dropped.
 */
export function normalizeServersObject(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const record = obj as Record<string, unknown>;
  const inner =
    record.mcpServers && typeof record.mcpServers === "object" && !Array.isArray(record.mcpServers)
      ? (record.mcpServers as Record<string, unknown>)
      : record;
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(inner)) {
    if (cfg && typeof cfg === "object") out[name] = cfg;
  }
  return out;
}

/** Merge server records; later records override earlier ones on name collision. */
export function mergeServers(...records: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rec of records) {
    for (const [name, cfg] of Object.entries(rec)) out[name] = cfg;
  }
  return out;
}

/**
 * Build namespaced, var-substituted registrations for every server in `servers`.
 */
export function buildMcpRegistrations(
  pluginName: string,
  servers: Record<string, unknown>,
  pluginRoot: string,
): McpRegistration[] {
  const vars = { CLAUDE_PLUGIN_ROOT: pluginRoot };
  return Object.entries(servers).map(([serverName, config]) => ({
    name: `${pluginName}:${serverName}`,
    config: substituteDeep(config, vars),
  }));
}

/**
 * Best-effort detection of a companion mcp extension by looking for an `mcp`
 * slash command. EventBus.emit has no ack, so command presence is our signal.
 */
export function detectMcpExtension(commands: { name: string }[]): boolean {
  return commands.some((c) => c.name === "mcp");
}
