import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandOutput, CommandRunner, GitCommandFailure } from "./types.js";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export class ExtensionCommandRunner implements CommandRunner {
  constructor(private readonly pi: ExtensionAPI) {}

  async run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandOutput> {
    const result = await this.pi.exec(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      signal: options.signal,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }
}

export function formatGitFailure(failure: GitCommandFailure): string {
  const rendered = failure.command.map((part) => JSON.stringify(part)).join(" ");
  const stderr = failure.stderr.trim();
  return stderr.length > 0
    ? `git ${rendered} failed with status ${failure.code}: ${stderr}`
    : `git ${rendered} failed with status ${failure.code}`;
}

export async function runGit(
  runner: CommandRunner,
  cwd: string,
  args: string[],
  options: { allowExitCodeOne?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const output = await runner.run("git", args, {
    cwd,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    signal: options.signal,
  });
  if (output.code === 0 || (options.allowExitCodeOne === true && output.code === 1)) {
    return output.stdout;
  }
  throw new Error(formatGitFailure({ command: args, code: output.code, stderr: output.stderr }));
}

export async function isInsideGitRepo(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<boolean> {
  const output = await runner.run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    signal,
  });
  return output.code === 0 && output.stdout.trim() === "true";
}
