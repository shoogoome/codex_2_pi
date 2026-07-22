/**
 * Layered discovery of context files that pi does NOT natively load.
 *
 * pi's `loadProjectContextFiles` already: (a) loads one global file from the
 * agent dir (~/.pi), and (b) walks cwd -> / taking the FIRST of
 * [AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD] per directory. This module only
 * discovers the net-new surface:
 *   - the SECOND same-directory file pi skipped (both AGENTS.md and CLAUDE.md),
 *   - `.claude/rules/**\/*.md` at every level (pi never loads these),
 *   - `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.pi/rules/` (user layer),
 *   - `CLAUDE.local.md` / `AGENTS.override.md` (local layer, codex parity).
 *
 * Dedup against pi-loaded paths happens later (in merge), because the set of
 * paths pi actually injected is only known at before_agent_start.
 */
import { dirname, join, resolve, sep } from "node:path";
import { extractPaths, parseFrontmatter } from "./frontmatter.js";
import { expandIncludes } from "./include.js";
import type { DiscoveredFile, FsLike, Layer } from "./types.js";

/** Directory markers that anchor a project root. */
const ROOT_MARKERS = [".git", ".hg", ".svn", "package.json"];

/** Base context filenames considered at each directory level. */
const CONTEXT_FILES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** Local-override filenames (codex/claude parity). */
const LOCAL_FILES = ["CLAUDE.local.md", "AGENTS.override.md"];

const RULES_EXT_RE = /\.md$/i;

export interface DiscoverOptions {
  cwd: string;
  home: string;
  fs: FsLike;
}

/**
 * Walk from `cwd` up to a project root and locate the anchoring directory.
 * Falls back to `cwd` when no marker is found.
 */
export function findProjectRoot(cwd: string, fs: FsLike): string {
  let dir = resolve(cwd);
  const root = resolve(sep);
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (fs.exists(join(dir, marker))) return dir;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

/**
 * Discover all net-new context files across user, project, and local layers.
 * Each file's content is @include-expanded and its frontmatter `paths` (if any)
 * captured as conditional globs. I/O flows through the injected FsLike.
 */
export function collectLayers(opts: DiscoverOptions): DiscoveredFile[] {
  const { cwd, home, fs } = opts;
  const out: DiscoveredFile[] = [];
  const seen = new Set<string>();

  const add = (path: string, layer: Layer): void => {
    const key = resolve(path);
    if (seen.has(key)) return;
    let raw: string;
    try {
      if (!fs.exists(path)) return;
      raw = fs.readFile(path);
    } catch {
      return;
    }
    seen.add(key);
    const parsed = parseFrontmatter(raw);
    const globs = extractPaths(parsed);
    const expanded = expandIncludes(path, parsed.content, { fs, home });
    out.push({ path, content: expanded, layer, globs });
  };

  // ---- user layer (net-new global sources) ----
  add(join(home, ".claude", "CLAUDE.md"), "user");
  add(join(home, ".claude", "CLAUDE.MD"), "user");
  for (const r of collectRulesDir(join(home, ".claude", "rules"), fs)) {
    add(r, "user");
  }
  for (const r of collectRulesDir(join(home, ".pi", "rules"), fs)) {
    add(r, "user");
  }

  // ---- project layer (root -> cwd, both context files + rules) ----
  const root = findProjectRoot(cwd, fs);
  for (const dir of ancestorChain(root, cwd)) {
    for (const name of CONTEXT_FILES) {
      add(join(dir, name), "project");
    }
    for (const r of collectRulesDir(join(dir, ".claude", "rules"), fs)) {
      add(r, "project");
    }
  }

  // ---- local layer (overrides, root -> cwd) ----
  for (const dir of ancestorChain(root, cwd)) {
    for (const name of LOCAL_FILES) {
      add(join(dir, name), "local");
    }
  }

  return out;
}

/**
 * Directory chain from `root` down to `cwd` inclusive (root first). When cwd is
 * not under root (unexpected), returns just [cwd].
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const r = resolve(root);
  const c = resolve(cwd);
  const chain: string[] = [];
  let dir = c;
  const fsRoot = resolve(sep);
  while (true) {
    chain.unshift(dir);
    if (dir === r) break;
    if (dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Ensure root is included even if the walk stopped early.
  if (chain[0] !== r && chain.includes(r) === false) {
    // cwd was not under root; just use cwd.
    return [c];
  }
  return chain;
}

/**
 * Recursively list `*.md` files under a rules directory (sorted for stable
 * ordering). Returns [] when the directory is absent.
 */
export function collectRulesDir(dir: string, fs: FsLike): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      if (!fs.exists(d)) return;
      entries = fs.readdir(d);
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      const full = join(d, e.name);
      if (e.isDirectory) {
        walk(full);
      } else if (RULES_EXT_RE.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}
