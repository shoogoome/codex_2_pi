import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../../shared/types.js";
import { detectGitBranch, resolveRepoTarget } from "./git.js";

function createFakeRunner(
  handler: (args: string[], cwd: string) => { code: number; stdout?: string; stderr?: string },
): CommandRunner {
  return {
    async run(_command, args, options) {
      const res = handler(args, options.cwd);
      return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
  };
}

describe("repo-branch git helpers", () => {
  it("detects normal, unborn, and detached HEAD branches", async () => {
    const normalRunner = createFakeRunner((args) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "feat/new-ui\n" };
      return { code: 1 };
    });
    expect(await detectGitBranch(normalRunner, "/repo")).toBe("feat/new-ui");

    const detachedRunner = createFakeRunner((args) => {
      if (args[0] === "symbolic-ref") return { code: 1 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "HEAD\n" };
      if (args[0] === "rev-parse" && args[1] === "--short") return { code: 0, stdout: "a1b2c3d\n" };
      return { code: 1 };
    });
    expect(await detectGitBranch(detachedRunner, "/repo")).toBe("HEAD@a1b2c3d");
  });

  it("resolves default cwd repo, file inside repo, non-git dir, and symbolic names", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "repo-branch-git-"));
    try {
      const repoDir = join(tempRoot, "my-project");
      const subDir = join(repoDir, "src");
      const filePath = join(subDir, "index.ts");
      const nonGitDir = join(tempRoot, "plain-dir");
      mkdirSync(subDir, { recursive: true });
      mkdirSync(nonGitDir, { recursive: true });
      writeFileSync(filePath, "export {};\n", "utf8");

      const runner = createFakeRunner((args, cwd) => {
        if (cwd.startsWith(repoDir)) {
          if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n" };
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${repoDir}\n` };
          if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
        }
        return { code: 128, stderr: "not a git repository" };
      });

      const fromCwd = await resolveRepoTarget(runner, subDir);
      expect(fromCwd).toEqual({
        key: repoDir,
        name: "my-project",
        path: repoDir,
        detectedBranch: "main",
      });

      // Leading @ and file path inside repo resolve to git toplevel
      const fromFile = await resolveRepoTarget(runner, tempRoot, `@${filePath}`);
      expect(fromFile).toEqual({
        key: repoDir,
        name: "my-project",
        path: repoDir,
        detectedBranch: "main",
      });

      const fromPlainDir = await resolveRepoTarget(runner, tempRoot, "./plain-dir");
      expect(fromPlainDir).toEqual({
        key: nonGitDir,
        name: "plain-dir",
        path: nonGitDir,
      });

      const symbolic = await resolveRepoTarget(runner, tempRoot, "external-service");
      expect(symbolic).toEqual({
        key: "name:external-service",
        name: "external-service",
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("propagates abort signal before spawning git commands", async () => {
    const runner = createFakeRunner(() => ({ code: 0, stdout: "true\n" }));
    const controller = new AbortController();
    controller.abort();
    await expect(resolveRepoTarget(runner, "/tmp", undefined, controller.signal)).rejects.toThrow();
  });
});
