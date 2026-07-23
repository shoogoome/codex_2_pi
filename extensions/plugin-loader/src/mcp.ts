// Pure builders for mcp:register-server payloads handed to the mcp extension.
//
// A plugin declares MCP servers either inline in its manifest (normalized into a
// { serverName: config } record by manifest.ts) and/or via a `.mcp.json` file.
// This module normalizes a parsed servers object, merges sources, substitutes
// CLAUDE_PLUGIN_ROOT, and namespaces each server as `${plugin}_${server}`
// (sanitized to an OpenAI-legal charset — never `:` — see sanitizeServerName).

import { substituteDeep } from "./vars.js";
import type { McpRegistration } from "./types.js";

/** Channel the mcp extension listens on. */
export const MCP_REGISTER_CHANNEL = "mcp:register-server";

/**
 * Sanitize a namespaced server name to OpenAI's function-name charset
 * (`[A-Za-z0-9_-]`). Historically this joined `${plugin}:${server}` with a
 * colon, but the colon is illegal in an OpenAI function name and — because the
 * mcp extension turns the server name into `mcp__<name>__<tool>` — a single
 * illegal char 400s the ENTIRE Chat Completions request. We now namespace with
 * `_` and strip any other illegal chars at the source. The mcp extension
 * re-sanitizes defensively (idempotent), so this is belt-and-suspenders. Kept
 * in sync with `extensions/mcp/src/naming.ts` `sanitizeMcpName`.
 */
export function sanitizeServerName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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
  pluginData = "",
): McpRegistration[] {
  const vars = { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData };
  return Object.entries(servers).map(([serverName, config]) => ({
    name: sanitizeServerName(`${pluginName}_${serverName}`),
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
