import { runGit } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";

export interface CommitLogEntry {
  sha: string;
  timestamp: number;
  subject: string;
}

export async function currentBranchName(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const output = await runGit(runner, cwd, ["branch", "--show-current"], { signal });
    const branch = output.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function localGitBranches(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const output = await runGit(runner, cwd, ["branch", "--format=%(refname:short)"], { signal });
    const branches = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort((a, b) => a.localeCompare(b));

    for (const preferred of ["main", "master"]) {
      const index = branches.indexOf(preferred);
      if (index >= 0) {
        branches.splice(index, 1);
        branches.unshift(preferred);
        break;
      }
    }
    return branches;
  } catch {
    return [];
  }
}

export async function mergeBaseWithHead(
  runner: CommandRunner,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const output = await runGit(runner, cwd, ["merge-base", "HEAD", branch], { signal });
    const sha = output.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function recentCommits(
  runner: CommandRunner,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitLogEntry[]> {
  try {
    const format = "%H%x1f%ct%x1f%s";
    const output = await runGit(runner, cwd, ["log", "-n", String(limit), `--pretty=format:${format}`], { signal });
    return output
      .split("\n")
      .map((line) => {
        const [sha = "", timestampText = "", subject = ""] = line.split("\u001f");
        const timestamp = Number.parseInt(timestampText, 10);
        if (!sha || !Number.isFinite(timestamp)) return undefined;
        return { sha, timestamp, subject };
      })
      .filter((entry): entry is CommitLogEntry => entry !== undefined);
  } catch {
    return [];
  }
}
