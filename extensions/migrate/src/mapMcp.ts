// Pure MCP mapping: normalize raw server entries into pi's Claude-compatible
// McpServerConfig, list existing server names, and merge a server into an
// existing .pi/mcp.json TEXT preserving all other keys. Mirrors the mcp
// extension's config.ts (which we cannot import across extension boundaries).

import type { McpServerConfig } from "./types.js";

/**
 * Classify + normalize a raw entry:
 * - string `command` → stdio {command, args?, env?}
 * - else string `url` → http {type: http|sse, url, headers?}
 * Returns undefined when neither shape applies.
 */
export function normalizeServerConfig(raw: unknown): McpServerConfig | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.command === "string" && obj.command.length > 0) {
    const config: McpServerConfig = { command: obj.command };
    if (Array.isArray(obj.args)) {
      config.args = obj.args.filter((a): a is string => typeof a === "string");
    }
    if (obj.env !== null && typeof obj.env === "object" && !Array.isArray(obj.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) config.env = env;
    }
    return config;
  }

  if (typeof obj.url === "string" && obj.url.length > 0) {
    const type = obj.type === "sse" ? "sse" : "http";
    const config: McpServerConfig = { type, url: obj.url };
    if (obj.headers !== null && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    return config;
  }

  return undefined;
}

/** True when a normalized server carries env vars or headers (possible secrets). */
export function serverHasSecrets(config: McpServerConfig): boolean {
  if ("command" in config) return config.env !== undefined && Object.keys(config.env).length > 0;
  return config.headers !== undefined && Object.keys(config.headers).length > 0;
}

/** Parse existing mcp.json text into a mutable object (never throws). */
function readConfigObject(text: string): { mcpServers: Record<string, unknown> } & Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const servers =
          obj.mcpServers !== null && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
            ? (obj.mcpServers as Record<string, unknown>)
            : {};
        return { ...obj, mcpServers: servers } as { mcpServers: Record<string, unknown> } & Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return { mcpServers: {} };
}

/** Existing server names already present in an mcp.json text. */
export function existingServerNames(text: string): Set<string> {
  return new Set(Object.keys(readConfigObject(text).mcpServers));
}

/** Return mcp.json text with `name` set to `config` (2-space JSON, trailing NL). */
export function applyServerToConfigText(text: string, name: string, config: McpServerConfig): string {
  const obj = readConfigObject(text);
  obj.mcpServers[name] = config;
  return `${JSON.stringify(obj, null, 2)}\n`;
}
