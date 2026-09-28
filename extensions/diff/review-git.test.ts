import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, utimes, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../shared/types.js";
import { displayReviewPath, parseReviewStatus, ReviewGit } from "./review-git.js";
const exec = promisify(execFile);
const dirs: string[] = [];
const runner: CommandRunner = {
  async run(command, args, options) {
    try { const out = await exec(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs, maxBuffer: 30 * 1024 * 1024 }); return { ...out, code: 0 }; }
    catch (error: any) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  },
};
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "review-git-")); dirs.push(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout;
  await git("init", "-q"); await git("config", "user.email", "test@example.com"); await git("config", "user.name", "Test");
  const put = (path: string, value: string | Buffer) => writeFile(join(root, path), value);
  const commit = async () => { await git("add", "--all"); await git("commit", "-qm", "test"); };
  return { root, git, put, commit, review: new ReviewGit(runner, root) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("ReviewGit real repositories", () => {
  it("resolves from subdirectories, separates worktrees and rejects nonrepos", async () => {
    const r = await repo(); await mkdir(join(r.root, "sub"));
    expect(await new ReviewGit(runner, join(r.root, "sub")).resolve()).toEqual(await r.review.resolve());
    await r.put("a", "one\n"); await r.commit();
    const other = await mkdtemp(join(tmpdir(), "review-worktree-")); dirs.push(other);
    await r.git("worktree", "add", "--detach", other);
    expect((await new ReviewGit(runner, other).resolve())?.key).not.toBe((await r.review.resolve())?.key);
    const empty = await mkdtemp(join(tmpdir(), "review-empty-")); dirs.push(empty);
    expect(await new ReviewGit(runner, empty).resolve()).toBeNull();
  });

  it("handles staged, mixed, cancellation and clean extra paths without mutating index", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit();
    await r.put("a", "staged\n"); await r.git("add", "a");
    expect((await r.review.detail("a")).text).toContain("+staged");
    await r.put("a", "working\n");
    const mixed = await r.review.detail("a"); expect(mixed.text).toContain("+working"); expect(mixed.text).not.toContain("+staged");
    expect(mixed.file.added).toBe(1); expect(mixed.file.removed).toBe(1);
    await r.put("a", "base\n");
    const index = await readFile(join(r.root, ".git/index"));
    const canceled = await r.review.detail("a");
    expect(canceled.text).toContain("[Staged changes]"); expect(canceled.text).toContain("[Unstaged changes]");
    expect(await readFile(join(r.root, ".git/index"))).toEqual(index);
    await r.git("reset", "--hard", "HEAD");
    expect((await r.review.snapshot(["a"])).get("a")?.dirty).toBe(false);
  });

  it("supports unborn HEAD, staged additions, untracked, deletion and ignores", async () => {
    const r = await repo(); await r.put("a", "first\n"); await r.git("add", "a"); await r.put("a", "second\n");
    expect((await r.review.detail("a")).text).toContain("+second");
    await r.put(".gitignore", "ignored\n"); await r.put("ignored", "secret");
    await r.put("new", "untracked\n");
    expect((await r.review.detail("new")).text).toContain("+untracked");
    expect((await r.review.snapshot(["ignored"])).has("ignored")).toBe(false);
    await r.commit(); await rm(join(r.root, "a"));
    expect((await r.review.detail("a")).text).toContain("-second");
    await r.put("temp", "x"); const old = (await r.review.snapshot()).get("temp")!;
    await rm(join(r.root, "temp")); const clean = (await r.review.snapshot(["temp"])).get("temp")!;
    expect(clean.dirty).toBe(false); expect(clean.fingerprint).not.toBe(old.fingerprint);
  });

  it("preserves NUL delimited unusual paths and rename relations", async () => {
    const r = await repo();
    const paths = ["中文 空格", "line\nbreak", "-flag", ":(glob)*", "tab\tname"];
    for (const path of paths) await r.put(path, "base\n");
    await r.commit();
    for (const path of paths) await r.put(path, "changed\n");
    const snapshot = await r.review.snapshot();
    for (const path of paths) { expect(snapshot.has(path)).toBe(true); expect((await r.review.detail(path)).text).toContain("+changed"); }
    await r.git("mv", "--", "中文 空格", "renamed\nname");
    const file = (await r.review.snapshot()).get("renamed\nname")!;
    expect(file.oldPath).toBe("中文 空格");
    expect((await r.review.detail(file.path)).text).toContain("+changed");
    expect(displayReviewPath("line\n\x1bbreak")).toBe("line\\u000a\\u001bbreak");
    expect(parseReviewStatus("R  new\0old\0").get("new")?.oldPath).toBe("old");
  });

  it("hashes full content independent of mtime/size and unrelated commits", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit(); await r.put("a", "aaaa\n");
    const a = (await r.review.snapshot()).get("a")!; const stat = await lstat(join(r.root, "a"));
    await r.put("a", "bbbb\n"); await utimes(join(r.root, "a"), stat.atime, stat.mtime);
    const b = (await r.review.snapshot()).get("a")!; expect(a.fingerprint).not.toBe(b.fingerprint);
    await r.put("other", "other\n"); await r.git("add", "other"); await r.git("commit", "-qm", "unrelated");
    expect((await r.review.snapshot()).get("a")?.fingerprint).toBe(b.fingerprint);
    await r.git("add", "a"); expect((await r.review.snapshot()).get("a")?.fingerprint).not.toBe(b.fingerprint);
  });

  it("includes mode and symlink target but never dereferences symlinks", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit();
    await chmod(join(r.root, "a"), 0o755); expect((await r.review.snapshot()).get("a")?.dirty).toBe(true);
    const outside = await mkdtemp(join(tmpdir(), "review-outside-")); dirs.push(outside);
    await writeFile(join(outside, "secret"), "private-one"); await symlink(join(outside, "secret"), join(r.root, "link"));
    const a = (await r.review.detail("link")); expect(a.text).not.toContain("private-one");
    await writeFile(join(outside, "secret"), "private-two"); expect((await r.review.detail("link")).token).toBe(a.token);
    await symlink(outside, join(r.root, "dirlink"));
    await expect(r.review.snapshot(["dirlink/secret"])).rejects.toThrow("symlink ancestor");
    await expect(r.review.snapshot(["../secret"])).rejects.toThrow("outside working tree");
  });

  it("hashes binary content and content beyond byte/line preview limits", async () => {
    const r = await repo(); await r.put("binary", Buffer.from([0, 1, 2, 3]));
    const binary = await r.review.detail("binary"); expect(binary.file.binary).toBe(true); expect(binary.text).toContain("Binary");
    await r.put("binary", Buffer.from([0, 1, 2, 4])); expect((await r.review.detail("binary")).token).not.toBe(binary.token);
    await r.put("big", "x".repeat(1024 * 1024 + 20) + "a"); const big = await r.review.detail("big"); expect(big.truncated).toBe(true);
    await r.put("big", "x".repeat(1024 * 1024 + 20) + "b"); expect((await r.review.detail("big")).token).not.toBe(big.token);
    await r.put("lines", "x\n".repeat(10001)); expect((await r.review.detail("lines")).truncated).toBe(true);
  });

  it("reports conflict stages and rejects a version changed during rendering", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit(); const branch = (await r.git("branch", "--show-current")).trim();
    await r.git("checkout", "-qb", "other"); await r.put("a", "other\n"); await r.commit();
    await r.git("checkout", branch); await r.put("a", "main\n"); await r.commit();
    await r.git("merge", "other").catch(() => {});
    const detail = await r.review.detail("a"); expect(detail.file.conflicted).toBe(true); expect(detail.text).toContain("Unresolved merge conflict");
    let changed = false;
    const race: CommandRunner = { async run(command, args, options) {
      const output = await runner.run(command, args, options);
      if (!changed && args.includes("diff") && !args.includes("--numstat")) { changed = true; await r.put("a", "raced\n"); }
      return output;
    } };
    await expect(new ReviewGit(race, r.root).detail("a")).rejects.toThrow("changing");
  });

  it("tracks rename source recreation and changed HEAD blobs, and excludes nested repositories", async () => {
    const r = await repo(); await r.put("old", "base\n"); await r.commit();
    await r.git("mv", "old", "new");
    const first = await r.review.detail("new");
    await r.put("old", "recreated\n");
    const second = await r.review.detail("new"); expect(second.token).not.toBe(first.token);
    await r.git("reset", "--hard", "HEAD");
    await r.put("old", "changed\n"); const before = (await r.review.snapshot()).get("old")!;
    await r.git("add", "old"); await r.git("commit", "-qm", "baseline"); await r.put("old", "base\n");
    expect((await r.review.snapshot()).get("old")?.fingerprint).not.toBe(before.fingerprint);
    await mkdir(join(r.root, "nested")); await exec("git", ["init", "-q"], { cwd: join(r.root, "nested") });
    await writeFile(join(r.root, "nested", "inside"), "not ours");
    expect([...(await r.review.snapshot(["nested/inside", ".git/config"])).keys()].some((p) => p.startsWith("nested") || p.startsWith(".git/"))).toBe(false);
  });

  it("does not execute external diff or textconv configured by the repository", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.put(".gitattributes", "a diff=unsafe\n"); await r.commit();
    await r.git("config", "diff.external", "definitely-not-a-command");
    await r.git("config", "diff.unsafe.textconv", "definitely-not-a-command");
    await r.put("a", "changed\n"); expect((await r.review.detail("a")).text).toContain("+changed");
  });

  it("rejects a file becoming dirty after the initial status sample", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit();
    let changed = false;
    const race: CommandRunner = { async run(command, args, options) {
      const output = await runner.run(command, args, options);
      if (!changed && args.includes("status")) { changed = true; await r.put("a", "new bytes\n"); }
      return output;
    } };
    await expect(new ReviewGit(race, r.root).snapshot(["a"])).rejects.toThrow("changing");
  });

  it("rejects index races even when porcelain status remains MM", async () => {
    const r = await repo(); await r.put("a", "base\n"); await r.commit();
    await r.put("a", "staged one\n"); await r.git("add", "a"); await r.put("a", "working two\n");
    let changed = false;
    const race: CommandRunner = { async run(command, args, options) {
      const output = await runner.run(command, args, options);
      if (!changed && args.includes("ls-files")) {
        changed = true; await r.git("add", "a"); await r.put("a", "working three\n");
      }
      return output;
    } };
    await expect(new ReviewGit(race, r.root).snapshot()).rejects.toThrow("baseline/index is changing");
  });

  it("omits huge tracked patches before capture, including huge deleted HEAD blobs", async () => {
    const r = await repo(); await r.put("a", "x".repeat(1024 * 1024 + 1)); await r.commit();
    await r.put("a", "small replacement\n");
    let patches = 0;
    const bounded: CommandRunner = { async run(command, args, options) {
      if (args.includes("diff") && !args.includes("--numstat")) patches++;
      return runner.run(command, args, options);
    } };
    const detail = await new ReviewGit(bounded, r.root).detail("a");
    expect(detail.truncated).toBe(true); expect(detail.text).toContain("Large file");
    expect(patches).toBe(0);
    await rm(join(r.root, "a"));
    expect((await new ReviewGit(bounded, r.root).detail("a")).truncated).toBe(true);
    expect(patches).toBe(0);
  });

  it("propagates cancellation, failures and the shared timeout", async () => {
    const r = await repo(); const controller = new AbortController(); controller.abort();
    await expect(r.review.snapshot([], controller.signal)).rejects.toThrow();
    const failing: CommandRunner = { async run(_command, _args, options) { expect(options.timeoutMs).toBe(30_000); throw new Error("timeout"); } };
    await expect(new ReviewGit(failing, r.root).snapshot()).rejects.toThrow("timeout");
  });
});
