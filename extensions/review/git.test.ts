import { describe, expect, it } from "vitest";
import type { CommandOutput, CommandRunner } from "../shared/types.js";
import { currentBranchName, localGitBranches, mergeBaseWithHead, recentCommits } from "./git.js";

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private readonly outputs: CommandOutput[];

  constructor(outputs: CommandOutput[]) {
    this.outputs = [...outputs];
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<CommandOutput> {
    this.calls.push([command, ...args, `cwd=${options.cwd}`]);
    const next = this.outputs.shift();
    if (!next) throw new Error(`missing fake output for ${command} ${args.join(" ")}`);
    return next;
  }
}

function out(code: number, stdout = "", stderr = ""): CommandOutput {
  return { code, stdout, stderr };
}

describe("review git helpers", () => {
  it("returns current branch name", async () => {
    const runner = new FakeRunner([out(0, "feature\n")]);
    await expect(currentBranchName(runner, "/repo")).resolves.toBe("feature");
  });

  it("returns sorted branches with main first when present", async () => {
    const runner = new FakeRunner([out(0, "feature\nmain\nzebra\n")]);
    await expect(localGitBranches(runner, "/repo")).resolves.toEqual(["main", "feature", "zebra"]);
  });

  it("returns recent commits parsed from git log", async () => {
    const runner = new FakeRunner([out(0, "abc\u001f1700000000\u001fFix bug\ndef\u001f1700000001\u001fAdd docs\n")]);
    await expect(recentCommits(runner, "/repo", 2)).resolves.toEqual([
      { sha: "abc", timestamp: 1700000000, subject: "Fix bug" },
      { sha: "def", timestamp: 1700000001, subject: "Add docs" },
    ]);
  });

  it("returns undefined when merge-base fails", async () => {
    const runner = new FakeRunner([out(1, "", "no merge base")]);
    await expect(mergeBaseWithHead(runner, "/repo", "main")).resolves.toBeUndefined();
  });
});
