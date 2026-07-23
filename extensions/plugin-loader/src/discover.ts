// Plugin discovery over an injected filesystem facade so the logic stays pure
// and testable (no real fs in tests). index.ts supplies a node:fs-backed facade.

import { basename, join } from "node:path";
import { parseManifest } from "./manifest.js";
import type { DiscoveredPlugin, PluginDirs } from "./types.js";

/** Minimal filesystem facade. Only what discovery needs. */
export interface FsFacade {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  readdirSync(p: string): string[];
  isDirectory(p: string): boolean;
}

/** Manifest probe order: pi-native first, then Claude, then Cursor. */
const MANIFEST_PROBES: { rel: string; kind: "pi" | "claude" | "cursor" }[] = [
  { rel: ".pi-plugin/plugin.json", kind: "pi" },
  { rel: ".claude-plugin/plugin.json", kind: "claude" },
  { rel: ".cursor-plugin/plugin.json", kind: "cursor" },
];

/**
 * Locate and read the highest-precedence manifest under a plugin root.
 * Returns undefined when no manifest file exists.
 */
export function probeManifest(
  root: string,
  fs: FsFacade,
): { path: string; kind: "pi" | "claude" | "cursor"; text: string } | undefined {
  for (const probe of MANIFEST_PROBES) {
    const path = join(root, probe.rel);
    if (fs.existsSync(path)) {
      let text = "";
      try {
        text = fs.readFileSync(path);
      } catch {
        text = "";
      }
      return { path, kind: probe.kind, text };
    }
  }
  return undefined;
}

/** Detect convention directories/files under a plugin root. */
export function detectDirs(root: string, fs: FsFacade): PluginDirs {
  const dirs: PluginDirs = {};
  const dirIf = (rel: string): string | undefined => {
    const p = join(root, rel);
    return fs.existsSync(p) && fs.isDirectory(p) ? p : undefined;
  };
  const fileIf = (rel: string): string | undefined => {
    const p = join(root, rel);
    return fs.existsSync(p) && !fs.isDirectory(p) ? p : undefined;
  };
  dirs.commands = dirIf("commands");
  dirs.skills = dirIf("skills");
  dirs.themes = dirIf("themes");
  dirs.outputStyles = dirIf("output-styles");
  dirs.agents = dirIf("agents");
  dirs.hooksJson = fileIf("hooks/hooks.json");
  dirs.mcpJson = fileIf(".mcp.json");
  return dirs;
}

/** Build a DiscoveredPlugin for a single plugin root directory. */
export function discoverPluginAt(root: string, fs: FsFacade): DiscoveredPlugin {
  const fallbackName = basename(root);
  const probed = probeManifest(root, fs);
  const manifest = parseManifest(probed?.text ?? undefined, fallbackName);
  return {
    name: manifest.name || fallbackName,
    root,
    manifest,
    manifestPath: probed?.path,
    manifestKind: probed?.kind ?? "none",
    dirs: detectDirs(root, fs),
  };
}

/**
 * Discover plugins one level under each root. Non-directory entries and missing
 * roots are ignored. When two plugins share a name, the first one wins (pass
 * higher-priority roots first).
 */
export function discoverPlugins(roots: string[], fs: FsFacade): DiscoveredPlugin[] {
  const seen = new Set<string>();
  const out: DiscoveredPlugin[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root) || !fs.isDirectory(root)) continue;
    let children: string[] = [];
    try {
      children = fs.readdirSync(root);
    } catch {
      children = [];
    }
    for (const child of children) {
      const childPath = join(root, child);
      if (!fs.isDirectory(childPath)) continue;
      const plugin = discoverPluginAt(childPath, fs);
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      out.push(plugin);
    }
  }
  return out;
}

/**
 * Discover plugin-manager records at their exact installation roots.
 *
 * Marketplace cache paths end in a version directory (commonly `0.0.0`) and
 * some legacy plugins do not ship a manifest. In that case discoverPluginAt()
 * falls back to the directory basename. Use the manager's stable record name
 * instead, otherwise every such plugin is called `0.0.0` and name de-duplication
 * drops all but the first one.
 */
export function discoverManagedPlugins(
  records: Array<{ name: string; path: string }>,
  fs: FsFacade,
): DiscoveredPlugin[] {
  return records.flatMap((record) => {
    if (!record.path || !fs.existsSync(record.path) || !fs.isDirectory(record.path)) return [];
    return [{ ...discoverPluginAt(record.path, fs), name: record.name }];
  });
}
