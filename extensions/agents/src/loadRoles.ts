// Directory-scan orchestration. fs access is injected so tests can supply fakes.

import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRole, AgentSource, FailedFile } from "./types.js";
import { parseRoleMarkdown } from "./frontmatter.js";
import { getBuiltInRoles } from "./builtIn.js";
import { roleSourceDirs } from "./sources.js";
import { dedupeByRealpath, mergeRoles, type RealpathEntry } from "./merge.js";

/** One .md file already read from disk. */
export interface RoleFileEntry {
  name: string;
  content: string;
  realpath: string;
}

/** A source directory plus the files found in it. */
export interface DirScan {
  dir: string;
  source: AgentSource;
  files: RoleFileEntry[];
}

export interface LoadRolesResult {
  roles: AgentRole[];
  failedFiles: FailedFile[];
}

/**
 * Given pre-read directory scans, parse them into roles, merge with built-ins,
 * de-dup by realpath, and collect parse failures. Pure w.r.t. fs.
 */
export function loadRolesFromScans(scans: DirScan[]): LoadRolesResult {
  const failedFiles: FailedFile[] = [];
  const bySource: Record<AgentSource, RealpathEntry[]> = {
    "built-in": [],
    user: [],
    project: [],
  };

  for (const scan of scans) {
    for (const file of scan.files) {
      if (!file.name.endsWith(".md")) continue;
      const r = parseRoleMarkdown(file.content, scan.source, file.name, scan.dir);
      if (r.ok) {
        bySource[scan.source].push({ role: r.role, realpath: file.realpath });
      } else if (!r.skip) {
        failedFiles.push({
          source: scan.source,
          filename: file.name,
          baseDir: scan.dir,
          error: r.error,
        });
      }
    }
  }

  // De-dup across ALL disk sources together so a single underlying file reached
  // via multiple dirs/symlinks (even across user + project) collapses to the
  // highest-priority source. Then partition back by source for layered merge.
  const deduped = dedupeByRealpath([...bySource.user, ...bySource.project]);
  const userRoles = deduped.filter((r) => r.source === "user");
  const projectRoles = deduped.filter((r) => r.source === "project");
  const builtIn = getBuiltInRoles();
  const roles = mergeRoles(builtIn, userRoles, projectRoles);
  return { roles, failedFiles };
}

/** Injectable fs surface (subset of node:fs/promises). */
export interface FsDeps {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string, enc: "utf8"): Promise<string>;
  realpath(path: string): Promise<string>;
}

const defaultFs: FsDeps = {
  readdir: (dir) => nodeFs.readdir(dir),
  readFile: (path, enc) => nodeFs.readFile(path, enc),
  realpath: (path) => nodeFs.realpath(path),
};

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "ENOENT"
  );
}

async function scanDir(
  dir: string,
  source: AgentSource,
  fs: FsDeps,
): Promise<DirScan> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (isENOENT(e)) return { dir, source, files: [] };
    throw e;
  }
  const files: RoleFileEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      const content = await fs.readFile(full, "utf8");
      let realpath = full;
      try {
        realpath = await fs.realpath(full);
      } catch {/* keep full path if realpath fails */}
      files.push({ name, content, realpath });
    } catch {/* skip unreadable file */}
  }
  return { dir, source, files };
}

/**
 * Load and merge all roles for a working directory. Thin fs wrapper around
 * loadRolesFromScans; missing dirs yield no files.
 */
export async function loadAllRoles(
  cwd: string,
  home: string = homedir(),
  fs: FsDeps = defaultFs,
): Promise<LoadRolesResult> {
  const dirs = roleSourceDirs(cwd, home);
  const scans = await Promise.all(dirs.map((d) => scanDir(d.dir, d.source, fs)));
  return loadRolesFromScans(scans);
}
