// Pure builders and reconciliation helpers for Pi's native MCP server API.
//
// A plugin declares MCP servers either inline in its manifest (normalized into a
// { serverName: config } record by manifest.ts) and/or via a `.mcp.json` file.
// This module normalizes a parsed servers object, merges sources, substitutes
// CLAUDE_PLUGIN_ROOT, and namespaces each server as `${plugin}_${server}`
// (sanitized to an OpenAI-legal charset — never `:` — see sanitizeServerName).

import { substituteDeep } from "./vars.js";
import type { McpRegistration } from "./types.js";

/** Subset of Pi 1.0's ExtensionAPI used to reconcile plugin-owned MCP servers. */
export interface McpRegistrar {
  registerMcpServer(name: string, config: unknown): void;
  unregisterMcpServer(name: string): void;
}

export interface McpRegistrationError {
  name: string;
  error: string;
}

export interface McpReconcileResult {
  registeredNames: Set<string>;
  errors: McpRegistrationError[];
}

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
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) out[name] = cfg;
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
  environment: Record<string, string | undefined> = {},
): McpRegistration[] {
  const vars = { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData };
  return Object.entries(servers).map(([serverName, config]) => {
    const substituted = substituteDeep(config, vars);
    // Native Pi expands env/headers, but validates URLs before interpolation.
    // Expand only URL placeholders here; missing values stay invalid and are
    // isolated by reconciliation. Never execute shell commands from URLs.
    if (substituted && typeof substituted === "object" && !Array.isArray(substituted)) {
      const record = substituted as Record<string, unknown>;
      if (typeof record.url === "string") {
        record.url = record.url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (placeholder, name: string) => environment[name] ?? placeholder);
      }
    }
    // Pi 1.0's native MCP API defaults to codemode, where tools are found with
    // searchTools() from codemode. Make that contract explicit while preserving
    // an author's direct/deferred/hidden exposure override.
    const normalizedConfig =
      substituted && typeof substituted === "object" && !Array.isArray(substituted)
        ? {
            ...(substituted as Record<string, unknown>),
            exposure: (substituted as Record<string, unknown>).exposure ?? "codemode",
          }
        : substituted;
    return {
      name: sanitizeServerName(`${pluginName}_${serverName}`),
      config: normalizedConfig,
    };
  });
}

/**
 * Replace the plugin-loader registrations through Pi 1.0's native MCP API.
 * Removed names are unregistered first so namespace-equivalent renames do not
 * collide. Invalid registrations are isolated and reported without preventing
 * the remaining plugin servers from being activated.
 */
export function reconcileMcpRegistrations(
  registrar: McpRegistrar,
  previousNames: ReadonlySet<string>,
  registrations: McpRegistration[],
): McpReconcileResult {
  const desiredNames = new Set(registrations.map((registration) => registration.name));
  const registeredNames = new Set<string>();
  const errors: McpRegistrationError[] = [];

  function unregister(name: string): void {
    try {
      registrar.unregisterMcpServer(name);
    } catch (error) {
      // Retain ownership so a later refresh can retry cleanup.
      registeredNames.add(name);
      errors.push({
        name,
        error: `failed to unregister: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const name of previousNames) {
    if (!desiredNames.has(name)) unregister(name);
  }

  for (const registration of registrations) {
    try {
      registrar.registerMcpServer(registration.name, registration.config);
      registeredNames.add(registration.name);
    } catch (error) {
      if (previousNames.has(registration.name)) unregister(registration.name);
      errors.push({
        name: registration.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { registeredNames, errors };
}
