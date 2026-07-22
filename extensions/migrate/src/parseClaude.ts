// Pure Claude config parsing over an injected FsFacade. Given a detected Claude
// source, extract mcpServers, hooks, subagents, commands, and memory presence
// into ParsedConfig fragments. Never throws — malformed files degrade to a
// skip plus a collected warning.

import { join, relative } from "node:path";
import { parseFrontmatter } from "./mapCommands.js";
import { normalizeServerConfig, serverHasSecrets } from "./mapMcp.js";
import type {
  DetectedSource,
  FsFacade,
  ParsedConfig,
  ParsedHook,
} from "./types.js";

function emptyParsed(): ParsedConfig {
  return { mcpServers: [], agents: [], commands: [], hooks: [], memory: [], warnings: [] };
}

function readJson(fs: FsFacade, path: string, out: ParsedConfig): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path);
  } catch (err) {
    out.warnings.push({ file: path, message: `unreadable: ${(err as Error).message}` });
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    out.warnings.push({ file: path, message: `invalid JSON: ${(err as Error).message}` });
    return undefined;
  }
}

/** Pull `mcpServers` out of a parsed JSON object into ParsedConfig. */
function collectMcpServers(parsed: unknown, origin: string, out: ParsedConfig): void {
  if (parsed === null || typeof parsed !== "object") return;
  const raw = (parsed as Record<string, unknown>).mcpServers;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    const config = normalizeServerConfig(entry);
    if (!config) {
      out.warnings.push({ file: origin, message: `mcp server "${name}": missing command or url` });
      continue;
    }
    out.mcpServers.push({ name, config, origin });
  }
}

/** Flatten Claude `hooks` map into (event, matcher, command) triples. */
function collectHooks(parsed: unknown, origin: string, out: ParsedConfig): void {
  if (parsed === null || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  if (obj.disableAllHooks === true) return;
  const hooks = obj.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return;

  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      if (m === null || typeof m !== "object") continue;
      const mo = m as Record<string, unknown>;
      const matcher = typeof mo.matcher === "string" && mo.matcher.length > 0 ? mo.matcher : undefined;
      const inner = mo.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (h === null || typeof h !== "object") continue;
        const ho = h as Record<string, unknown>;
        const command = ho.command;
        const hookType = typeof ho.type === "string" ? ho.type : "command";
        if (typeof command !== "string" || command.length === 0) continue;
        const hook: ParsedHook = { event, hookType, command, origin };
        if (matcher !== undefined) hook.matcher = matcher;
        out.hooks.push(hook);
      }
    }
  }
}

/** Parse `.claude/agents/*.md` subagent files. */
function collectAgents(fs: FsFacade, dir: string, out: ParsedConfig): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    if (fs.isDirectory(path)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path);
    } catch (err) {
      out.warnings.push({ file: path, message: `unreadable: ${(err as Error).message}` });
      continue;
    }
    const { attrs, body } = parseFrontmatter(content);
    const name = (attrs.name ?? entry.replace(/\.md$/i, "")).trim();
    if (!name) {
      out.warnings.push({ file: path, message: "agent has no name" });
      continue;
    }
    out.agents.push({
      name,
      description: attrs.description,
      tools: attrs.tools,
      model: attrs.model,
      body,
      origin: path,
    });
  }
}

/** Recursively collect `.md` command files under commands/ (nested dirs kept). */
function collectCommands(fs: FsFacade, base: string, dir: string, out: ParsedConfig): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (fs.isDirectory(path)) {
      collectCommands(fs, base, path, out);
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    let source: string;
    try {
      source = fs.readFileSync(path);
    } catch (err) {
      out.warnings.push({ file: path, message: `unreadable: ${(err as Error).message}` });
      continue;
    }
    out.commands.push({ relPath: relative(base, path), source, origin: path });
  }
}

/** Parse one detected Claude source into a ParsedConfig fragment. */
export function parseClaudeSource(source: DetectedSource, fs: FsFacade): ParsedConfig {
  const out = emptyParsed();
  if (source.kind !== "claude") return out;
  const f = source.files;

  // settings.json + settings.local.json: mcpServers + hooks.
  for (const settingsPath of [f.settings, f.settingsLocal]) {
    if (!settingsPath) continue;
    const parsed = readJson(fs, settingsPath, out);
    if (parsed === undefined) continue;
    collectMcpServers(parsed, settingsPath, out);
    collectHooks(parsed, settingsPath, out);
  }

  // .claude/.mcp.json: mcpServers only.
  if (f.mcpJson) {
    const parsed = readJson(fs, f.mcpJson, out);
    if (parsed !== undefined) collectMcpServers(parsed, f.mcpJson, out);
  }

  if (f.agentsDir) collectAgents(fs, f.agentsDir, out);
  if (f.commandsDir) collectCommands(fs, f.commandsDir, f.commandsDir, out);

  return out;
}

/** True when any parsed server carries env/headers that may hold secrets. */
export function anyServerHasSecrets(parsed: ParsedConfig): boolean {
  return parsed.mcpServers.some((s) => serverHasSecrets(s.config));
}
