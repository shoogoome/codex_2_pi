import { isInsideGitRepo, runGit } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";

export const NOT_GIT_REPO_MESSAGE = "`/diff` — _not inside a git repository_";

export interface ComputeGitDiffOptions {
  nullDevice?: string;
  signal?: AbortSignal;
}

export async function computeGitDiff(runner: CommandRunner, cwd: string, options: ComputeGitDiffOptions = {}): Promise<string> {
  const inside = await isInsideGitRepo(runner, cwd, options.signal);
  if (!inside) return NOT_GIT_REPO_MESSAGE;

  const [trackedDiff, untrackedOutput] = await Promise.all([
    runGit(runner, cwd, ["diff", "--color"], { allowExitCodeOne: true, signal: options.signal }),
    runGit(runner, cwd, ["ls-files", "--others", "--exclude-standard"], { signal: options.signal }),
  ]);

  const nullDevice = options.nullDevice ?? (process.platform === "win32" ? "NUL" : "/dev/null");
  const untrackedFiles = untrackedOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let untrackedDiff = "";
  for (const file of untrackedFiles) {
    untrackedDiff += await runGit(runner, cwd, ["diff", "--color", "--no-index", "--", nullDevice, file], {
      allowExitCodeOne: true,
      signal: options.signal,
    });
  }

  const diff = `${trackedDiff}${untrackedDiff}`;
  return diff.length > 0 ? diff : "No changes.";
}
