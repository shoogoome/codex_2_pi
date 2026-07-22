// Pure decision logic for mapping a discovered plugin's convention dirs +
// manifest declarations onto pi resource types (skillPaths / themePaths /
// prompt (command) sources) and the ordered MCP server config sources.
//
// These functions never touch the filesystem: index.ts supplies the directory
// markdown listing and performs all reads/writes. Keeping the mapping pure lets
// the "which file becomes which pi resource" contract be unit-tested directly.

import { isAbsolute, join } from "node:path";
import type { DiscoveredPlugin, PluginDirs } from "./types.js";

/** A plugin's skills/ dir (if present) maps to resources_discover skillPaths. */
export function skillPathsFor(dirs: PluginDirs): string[] {
  return dirs.skills ? [dirs.skills] : [];
}

/** A plugin's themes/ dir (if present) maps to resources_discover themePaths. */
export function themePathsFor(dirs: PluginDirs): string[] {
  return dirs.themes ? [dirs.themes] : [];
}

/**
 * Convention features that are recognized but not hot-loadable via
 * resources_discover yet (hooks need a hooks-runner, agents need a subagent
 * extension). Surfaced in /plugin + README, never silently dropped.
 */
export function deferredFor(dirs: PluginDirs): string[] {
  const out: string[] = [];
  if (dirs.hooksJson) out.push("hooks");
  if (dirs.agents) out.push("agents");
  return out;
}

/**
 * Combine command `*.md` files discovered in the commands/ dir with any
 * manifest-declared command sources, resolving relative sources against the
 * plugin root and de-duplicating. The resulting list feeds command→prompt
 * transformation (each becomes a `<plugin>_<command>.md` prompt template).
 */
export function commandFilesFor(plugin: DiscoveredPlugin, dirMarkdown: string[]): string[] {
  const files = [...dirMarkdown];
  for (const entry of plugin.manifest.commands) {
    if (!entry.source) continue;
    const p = isAbsolute(entry.source) ? entry.source : join(plugin.root, entry.source);
    if (!files.includes(p)) files.push(p);
  }
  return files;
}

/**
 * Ordered MCP server config source paths for the precedence merge: the
 * convention `.mcp.json` first (lowest precedence), then manifest-declared
 * external paths. Inline manifest servers are merged last by the caller and
 * therefore win. Relative manifest paths are resolved against the plugin root.
 */
export function mcpServerSourcePaths(plugin: DiscoveredPlugin): string[] {
  const paths: string[] = [];
  if (plugin.dirs.mcpJson) paths.push(plugin.dirs.mcpJson);
  for (const rel of plugin.manifest.mcpServers.paths) {
    paths.push(isAbsolute(rel) ? rel : join(plugin.root, rel));
  }
  return paths;
}
