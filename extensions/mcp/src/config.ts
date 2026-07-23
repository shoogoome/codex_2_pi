// Pure config helpers: read/parse/merge MCP server config. All filesystem I/O
// is left to index.ts — these functions operate on strings and plain objects
// so they are trivially unit-testable.

import path from "node:path";
import type { McpServerConfig, MergedServer, ServerSource } from "./types.js";

export interface ParseResult {
  servers: Record<string, McpServerConfig>;
  errors: string[];
}

/**
 * Decide whether a raw entry is a valid stdio or http server config and
 * normalize it. Returns undefined when the entry cannot be classified.
 *
 * - Has a string `command` → stdio.
 * - Otherwise has a string `url` (and/or type http|sse) → http.
 */
export function normalizeServerConfig(raw: unknown): McpServerConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.command === "string" && obj.command.length > 0) {
    const config: McpServerConfig = { command: obj.command };
    if (Array.isArray(obj.args)) {
      config.args = obj.args.filter((a): a is string => typeof a === "string");
    }
    if (obj.env !== null && typeof obj.env === "object") {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      config.env = env;
    }
    return config;
  }

  if (typeof obj.url === "string" && obj.url.length > 0) {
    const type = obj.type === "sse" ? "sse" : "http";
    const config: McpServerConfig = { type, url: obj.url };
    if (obj.headers !== null && typeof obj.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
      config.headers = headers;
    }
    return config;
  }

  return undefined;
}

/**
 * Parse the text of an mcp.json file. Never throws: malformed JSON or missing
 * `mcpServers` degrade to an empty server map plus a collected error message.
 */
export function parseMcpConfig(text: string): ParseResult {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  const trimmed = text.trim();
  if (trimmed.length === 0) return { servers, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    errors.push(`invalid JSON: ${(err as Error).message}`);
    return { servers, errors };
  }

  if (parsed === null || typeof parsed !== "object") {
    errors.push("config root is not an object");
    return { servers, errors };
  }

  const rawServers = (parsed as Record<string, unknown>).mcpServers;
  if (rawServers === undefined) {
    // No mcpServers section: safe degrade, no error.
    return { servers, errors };
  }
  if (rawServers === null || typeof rawServers !== "object") {
    errors.push("mcpServers is not an object");
    return { servers, errors };
  }

  for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
    const normalized = normalizeServerConfig(raw);
    if (normalized === undefined) {
      errors.push(`server "${name}": missing command or url`);
      continue;
    }
    servers[name] = normalized;
  }

  return { servers, errors };
}

/**
 * Merge global and project server maps. Project entries win on name conflicts.
 * Returns a name→MergedServer table carrying provenance.
 */
export function mergeMcpConfigs(
  global: Record<string, McpServerConfig>,
  project: Record<string, McpServerConfig>,
): Record<string, MergedServer> {
  const merged: Record<string, MergedServer> = {};
  for (const [name, config] of Object.entries(global)) {
    merged[name] = { name, config, source: "global" };
  }
  for (const [name, config] of Object.entries(project)) {
    merged[name] = { name, config, source: "project" };
  }
  return merged;
}

/** Add or override a single runtime server (e.g. from plugin-loader). */
export function withRuntimeServer(
  merged: Record<string, MergedServer>,
  name: string,
  config: McpServerConfig,
  source: ServerSource = "runtime",
): Record<string, MergedServer> {
  return { ...merged, [name]: { name, config, source } };
}

export interface ConfigPaths {
  globalPath: string;
  projectPath: string;
  legacyGlobalPath: string;
  legacyProjectPath: string;
}

/**
 * Pure path construction. `mcp.json` is Pi's canonical path; `.mcp.json` is
 * also read for Claude/Cursor compatibility when the canonical file is absent.
 */
export function computeConfigPaths(home: string, cwd: string): ConfigPaths {
  return {
    globalPath: path.join(home, ".pi", "agent", "mcp.json"),
    projectPath: path.join(cwd, ".pi", "mcp.json"),
    legacyGlobalPath: path.join(home, ".pi", "agent", ".mcp.json"),
    legacyProjectPath: path.join(cwd, ".mcp.json"),
  };
}

/**
 * The on-disk config file that owns a server of the given source. Returns
 * undefined for `runtime` (plugin-injected) servers, which have no config file
 * and must never be written to disk — this is the correctness guarantee behind
 * /mcp remove writing the right file instead of always the project config.
 */
export function configPathForSource(
  source: ServerSource,
  paths: Pick<ConfigPaths, "globalPath" | "projectPath">,
): string | undefined {
  if (source === "global") return paths.globalPath;
  if (source === "project") return paths.projectPath;
  return undefined;
}

/** Parse existing file text into a mutable {mcpServers} object (never throws). */
function readConfigObject(text: string): { mcpServers: Record<string, unknown> } {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const servers =
          obj.mcpServers !== null && typeof obj.mcpServers === "object"
            ? (obj.mcpServers as Record<string, unknown>)
            : {};
        return { ...obj, mcpServers: servers } as { mcpServers: Record<string, unknown> };
      }
    } catch {
      // fall through to empty
    }
  }
  return { mcpServers: {} };
}

/** Pure: return config file text with `name` set to `config` (2-space JSON). */
export function applyServerToConfigText(
  text: string,
  name: string,
  config: McpServerConfig,
): string {
  const obj = readConfigObject(text);
  obj.mcpServers[name] = config;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Pure: return config file text with `name` removed (2-space JSON). */
export function removeServerFromConfigText(text: string, name: string): string {
  const obj = readConfigObject(text);
  delete obj.mcpServers[name];
  return `${JSON.stringify(obj, null, 2)}\n`;
}
