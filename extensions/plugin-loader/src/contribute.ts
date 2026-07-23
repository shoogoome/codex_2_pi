// Pure decision logic for mapping a discovered plugin's convention dirs +
// manifest declarations onto pi resource types (skillPaths / themePaths /
// prompt (command) sources) and the ordered MCP server config sources.
//
// These functions never touch the filesystem: index.ts supplies the directory
// markdown listing and performs all reads/writes. Keeping the mapping pure lets
// the "which file becomes which pi resource" contract be unit-tested directly.

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DiscoveredPlugin, PluginDirs } from "./types.js";

function safeDeclaredPath(root: string, raw: string): string | undefined {
  const target = resolve(root, raw);
  const rel = relative(resolve(root), target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : target;
}

/** Convention + manifest-declared skill paths, constrained to the plugin root. */
export function skillPathsFor(dirs: PluginDirs, root?: string, declared: string[] = []): string[] {
  const paths = dirs.skills ? [dirs.skills] : [];
  if (root) paths.push(...declared.map((item) => safeDeclaredPath(root, item)).filter((item): item is string => Boolean(item)));
  return [...new Set(paths)];
}

/** Convention + manifest-declared output-style paths, constrained to the plugin root. */
export function outputStylePathsFor(dirs: PluginDirs, root?: string, declared: string[] = []): string[] {
  const paths = dirs.outputStyles ? [dirs.outputStyles] : [];
  if (root) paths.push(...declared.map((item) => safeDeclaredPath(root, item)).filter((item): item is string => Boolean(item)));
  return [...new Set(paths)];
}

/** Agent markdown directories/files declared by convention or manifest. */
export function agentPathsFor(plugin: DiscoveredPlugin): string[] {
  const paths = plugin.dirs.agents ? [plugin.dirs.agents] : [];
  const declared = Array.isArray(plugin.manifest.agents) ? plugin.manifest.agents : [];
  paths.push(...declared.map((item) => safeDeclaredPath(plugin.root, item)).filter((item): item is string => Boolean(item)));
  return [...new Set(paths)];
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
