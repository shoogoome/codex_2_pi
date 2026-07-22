// Hand-written, tolerant parser for the subset of the Claude PluginManifest that
// plugin-loader consumes. No zod (no new deps): every field is validated by
// hand and missing/malformed fields degrade gracefully instead of throwing.

import type {
  CommandEntry,
  McpServersSpec,
  PluginManifest,
} from "./types.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Normalize the `commands` field, which may be a single path, an array of
 * paths, or a record of name → metadata.
 */
function normalizeCommands(v: unknown): CommandEntry[] {
  if (v == null) return [];
  if (typeof v === "string") return [{ source: v }];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((source) => ({ source }));
  }
  if (typeof v === "object") {
    const out: CommandEntry[] = [];
    for (const [name, meta] of Object.entries(v as Record<string, unknown>)) {
      if (!meta || typeof meta !== "object") {
        out.push({ name });
        continue;
      }
      const m = meta as Record<string, unknown>;
      out.push({
        name,
        source: asString(m.source),
        content: asString(m.content),
        description: asString(m.description),
        argumentHint: asString(m.argumentHint) ?? asString(m["argument-hint"]),
        allowedTools: asStringArray(m.allowedTools ?? m["allowed-tools"]),
        model: asString(m.model),
      });
    }
    return out;
  }
  return [];
}

/**
 * Normalize `mcpServers`, which may be a path string, an inline record, or an
 * array mixing paths and inline records.
 */
function normalizeMcpServers(v: unknown): McpServersSpec {
  const spec: McpServersSpec = { inline: {}, paths: [] };
  const consume = (item: unknown): void => {
    if (typeof item === "string") {
      spec.paths.push(item);
      return;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      // An inline record of serverName → config.
      for (const [k, cfg] of Object.entries(item as Record<string, unknown>)) {
        spec.inline[k] = cfg;
      }
    }
  };
  if (Array.isArray(v)) {
    for (const item of v) consume(item);
  } else {
    consume(v);
  }
  return spec;
}

/**
 * Parse a raw manifest JSON string (or already-parsed object) into our subset.
 * `fallbackName` (typically the plugin directory name) is used when the
 * manifest is missing/invalid or omits `name`. Never throws.
 */
export function parseManifest(raw: unknown, fallbackName: string): PluginManifest {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }

  return {
    name: asString(obj.name) ?? fallbackName,
    version: asString(obj.version),
    description: asString(obj.description),
    commands: normalizeCommands(obj.commands),
    agents: asStringArray(obj.agents),
    skills: asStringArray(obj.skills),
    outputStyles: asStringArray(obj.outputStyles ?? obj["output-styles"]),
    mcpServers: normalizeMcpServers(obj.mcpServers),
    hooks: obj.hooks,
  };
}

/** Build a minimal manifest for a plugin dir that has no manifest file. */
export function minimalManifest(fallbackName: string): PluginManifest {
  return {
    name: fallbackName,
    commands: [],
    agents: [],
    skills: [],
    outputStyles: [],
    mcpServers: { inline: {}, paths: [] },
  };
}
