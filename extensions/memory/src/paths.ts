/**
 * Pure git-root + memory-dir location. No node:fs — all disk access flows
 * through the injected FsLike so tests can drive the walk over an in-memory map.
 *
 * Storage policy (spec): prefer <gitRoot>/.pi/memory. When cwd is not inside a
 * git repo, fall back to <home>/.pi/agent/memory/<projectHash>, matching the
 * ~/.pi/agent/* convention used by the mcp / plugin-loader extensions.
 */
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AGENT_MEMORY_SUBDIR,
  MEMORY_INDEX_FILENAME,
  type FsLike,
} from "./types.js";

/**
 * Walk from `cwd` upward looking for a `.git` entry (directory in a normal
 * clone, a file in a worktree/submodule). Returns the containing directory, or
 * null when none is found up to the filesystem root.
 */
export function findGitRoot(cwd: string, fs: FsLike): string | null {
  let dir = resolve(cwd);
  const fsRoot = resolve(sep);
  while (true) {
    if (fs.exists(join(dir, ".git"))) return dir;
    if (dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Deterministic short hash of an absolute path, used to scope the off-repo
 * fallback memory dir. Stable across runs + platforms (djb2, base36), so tests
 * can assert exact directory names.
 */
export function hashProject(cwd: string): string {
  const abs = resolve(cwd);
  let h = 5381;
  for (let i = 0; i < abs.length; i++) {
    // djb2: h * 33 + c, kept in 32-bit unsigned range.
    h = (Math.imul(h, 33) + abs.charCodeAt(i)) >>> 0;
  }
  const label = basename(abs).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
  return `${label}-${h.toString(36)}`;
}

export interface ResolveMemoryDirOptions {
  cwd: string;
  home: string;
  fs: FsLike;
}

/**
 * Resolve the absolute memory directory for the current cwd. In-repo →
 * <gitRoot>/.pi/memory; off-repo → <home>/.pi/agent/memory/<hash(cwd)>.
 */
export function resolveMemoryDir(opts: ResolveMemoryDirOptions): string {
  const { cwd, home, fs } = opts;
  const gitRoot = findGitRoot(cwd, fs);
  if (gitRoot) {
    return join(gitRoot, ".pi", "memory");
  }
  return join(home, ...AGENT_MEMORY_SUBDIR.split("/"), hashProject(cwd));
}

/** Absolute path of the MEMORY.md index inside a resolved memory dir. */
export function memoryIndexPath(memoryDir: string): string {
  return join(memoryDir, MEMORY_INDEX_FILENAME);
}

/**
 * Slugify a topic name into a safe .md filename (lowercase, dashed). Falls back
 * to "topic" when the name has no usable characters.
 */
export function topicFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "topic"}.md`;
}

/** Absolute path of a topic file (by name) inside a resolved memory dir. */
export function topicPath(memoryDir: string, name: string): string {
  return join(memoryDir, topicFileName(name));
}
