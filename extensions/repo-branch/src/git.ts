import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS } from "../../shared/git.js";
import type { CommandRunner } from "../../shared/types.js";

export interface ResolvedRepoTarget {
  key: string;
  name: string;
  path?: string;
  detectedBranch?: string;
}

export interface GitRepoInfo {
  root: string;
  name: string;
  branch?: string;
}

export function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

async function runGitSafe(
  runner: CommandRunner,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string }> {
  signal?.throwIfAborted();
  try {
    const out = await runner.run("git", args, {
      cwd,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
      signal,
    });
    signal?.throwIfAborted();
    return { ok: out.code === 0, stdout: out.stdout };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, stdout: "" };
  }
}

export async function readGitRepoInfo(
  runner: CommandRunner,
  dir: string,
  signal?: AbortSignal,
): Promise<GitRepoInfo | null> {
  const inside = await runGitSafe(runner, dir, ["rev-parse", "--is-inside-work-tree"], signal);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return null;
  }

  const top = await runGitSafe(runner, dir, ["rev-parse", "--show-toplevel"], signal);
  const rawRoot = top.ok ? top.stdout.replace(/\r?\n$/, "").trim() : "";
  if (!rawRoot) return null;

  const root = await safeRealpath(rawRoot);
  const name = basename(root) || root;
  const branch = await detectGitBranch(runner, root, signal);

  return { root, name, ...(branch ? { branch } : {}) };
}

export async function detectGitBranch(
  runner: CommandRunner,
  repoDir: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Prefer symbolic-ref so unborn branches (before initial commit) still resolve cleanly.
  const symbolic = await runGitSafe(runner, repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  const symName = symbolic.ok ? symbolic.stdout.trim() : "";
  if (symName) return symName;

  const abbrev = await runGitSafe(runner, repoDir, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const abbrevName = abbrev.ok ? abbrev.stdout.trim() : "";
  if (abbrevName && abbrevName !== "HEAD") return abbrevName;

  const sha = await runGitSafe(runner, repoDir, ["rev-parse", "--short", "HEAD"], signal);
  const shortSha = sha.ok ? sha.stdout.trim() : "";
  if (shortSha) return `HEAD@${shortSha}`;

  return undefined;
}

export async function resolveRepoTarget(
  runner: CommandRunner,
  cwd: string,
  repoInput?: string,
  signal?: AbortSignal,
): Promise<ResolvedRepoTarget> {
  const trimmed = repoInput ? stripLeadingAt(repoInput.trim()) : "";
  if (!trimmed) {
    const gitInfo = await readGitRepoInfo(runner, cwd, signal);
    if (gitInfo) {
      return {
        key: gitInfo.root,
        name: gitInfo.name,
        path: gitInfo.root,
        ...(gitInfo.branch ? { detectedBranch: gitInfo.branch } : {}),
      };
    }
    const canonical = await safeRealpath(cwd);
    return {
      key: canonical,
      name: basename(canonical) || canonical,
      path: canonical,
    };
  }

  const candidate = resolve(cwd, trimmed);
  let onDiskDir: string | undefined;
  try {
    const stats = await stat(candidate);
    onDiskDir = stats.isDirectory() ? candidate : dirname(candidate);
  } catch {
    onDiskDir = undefined;
  }

  if (onDiskDir) {
    const gitInfo = await readGitRepoInfo(runner, onDiskDir, signal);
    if (gitInfo) {
      return {
        key: gitInfo.root,
        name: gitInfo.name,
        path: gitInfo.root,
        ...(gitInfo.branch ? { detectedBranch: gitInfo.branch } : {}),
      };
    }
    const canonical = await safeRealpath(onDiskDir);
    return {
      key: canonical,
      name: basename(canonical) || canonical,
      path: canonical,
    };
  }

  // Fallback for mocked CommandRunner paths in tests or symbolic repository names.
  const gitInfo = await readGitRepoInfo(runner, candidate, signal);
  if (gitInfo) {
    return {
      key: gitInfo.root,
      name: gitInfo.name,
      path: gitInfo.root,
      ...(gitInfo.branch ? { detectedBranch: gitInfo.branch } : {}),
    };
  }

  return {
    key: `name:${trimmed}`,
    name: trimmed,
  };
}
