import { describe, expect, it } from "vitest";
import {
  findGitRoot,
  hashProject,
  memoryIndexPath,
  resolveMemoryDir,
  topicFileName,
  topicPath,
} from "./paths.js";
import { makeFs } from "../test-helpers.js";

describe("findGitRoot", () => {
  it("finds the nearest ancestor containing .git", () => {
    const fs = makeFs({ "/home/u/proj/.git/HEAD": "ref" });
    expect(findGitRoot("/home/u/proj/src/nested", fs)).toBe("/home/u/proj");
  });

  it("treats a .git file (worktree) as a root marker", () => {
    const fs = makeFs({ "/repo/.git": "gitdir: /elsewhere" });
    expect(findGitRoot("/repo/a/b", fs)).toBe("/repo");
  });

  it("returns null when no .git is found", () => {
    const fs = makeFs({ "/home/u/proj/file.txt": "x" });
    expect(findGitRoot("/home/u/proj", fs)).toBeNull();
  });
});

describe("hashProject", () => {
  it("is deterministic and path-derived", () => {
    expect(hashProject("/a/b/c")).toBe(hashProject("/a/b/c"));
    expect(hashProject("/a/b/c")).not.toBe(hashProject("/a/b/d"));
  });

  it("prefixes with a sanitized basename", () => {
    expect(hashProject("/x/My Proj!")).toMatch(/^My-Proj--[a-z0-9]+$/);
  });
});

describe("resolveMemoryDir", () => {
  it("uses <gitRoot>/.pi/memory in a repo", () => {
    const fs = makeFs({ "/repo/.git/HEAD": "ref" });
    expect(resolveMemoryDir({ cwd: "/repo/pkg", home: "/home/u", fs })).toBe(
      "/repo/.pi/memory",
    );
  });

  it("falls back to <home>/.pi/agent/memory/<hash> off-repo", () => {
    const fs = makeFs({});
    const dir = resolveMemoryDir({ cwd: "/tmp/work", home: "/home/u", fs });
    expect(dir).toBe(`/home/u/.pi/agent/memory/${hashProject("/tmp/work")}`);
  });
});

describe("path builders", () => {
  it("builds the index path", () => {
    expect(memoryIndexPath("/repo/.pi/memory")).toBe(
      "/repo/.pi/memory/MEMORY.md",
    );
  });

  it("slugifies topic names into filenames", () => {
    expect(topicFileName("Coding Style!")).toBe("coding-style.md");
    expect(topicFileName("  ---  ")).toBe("topic.md");
    expect(topicPath("/m", "User Prefs")).toBe("/m/user-prefs.md");
  });
});
