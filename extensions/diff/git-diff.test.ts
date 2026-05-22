import { describe, expect, it } from "vitest";
import type { CommandOutput, CommandRunner } from "../shared/types.js";
import { computeGitDiff, NOT_GIT_REPO_MESSAGE } from "./git-diff.js";

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  private readonly outputs: CommandOutput[];

  constructor(outputs: CommandOutput[]) {
    this.outputs = [...outputs];
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<CommandOutput> {
    this.calls.push({ command, args, cwd: options.cwd });
    const next = this.outputs.shift();
    if (!next) throw new Error(`missing fake output for ${command} ${args.join(" ")}`);
    return next;
  }
}

function out(code: number, stdout = "", stderr = ""): CommandOutput {
  return { code, stdout, stderr };
}

describe("computeGitDiff", () => {
  it("returns the Codex not-git message outside git repositories", async () => {
    const runner = new FakeRunner([out(128, "", "fatal: not a git repository")]);

    await expect(computeGitDiff(runner, "/work")).resolves.toBe(NOT_GIT_REPO_MESSAGE);
    expect(runner.calls).toEqual([{ command: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd: "/work" }]);
  });

  it("returns No changes. for a clean repository", async () => {
    const runner = new FakeRunner([out(0, "true\n"), out(0, ""), out(0, "")]);

    await expect(computeGitDiff(runner, "/work")).resolves.toBe("No changes.");
  });

  it("concatenates tracked and untracked diffs", async () => {
    const runner = new FakeRunner([
      out(0, "true\n"),
      out(1, "tracked diff\n"),
      out(0, "new.txt\n"),
      out(1, "untracked diff\n"),
    ]);

    await expect(computeGitDiff(runner, "/work", { nullDevice: "/dev/null" })).resolves.toBe("tracked diff\nuntracked diff\n");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--color"],
      ["ls-files", "--others", "--exclude-standard"],
      ["diff", "--color", "--no-index", "--", "/dev/null", "new.txt"],
    ]);
  });

  it("rejects unexpected git diff exit codes", async () => {
    const runner = new FakeRunner([out(0, "true\n"), out(2, "", "bad diff"), out(0, "")]);

    await expect(computeGitDiff(runner, "/work")).rejects.toThrow('git "diff" "--color" failed with status 2: bad diff');
  });
});
