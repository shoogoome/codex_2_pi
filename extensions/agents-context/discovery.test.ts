import { describe, expect, it } from "vitest";
import {
  ancestorChain,
  collectLayers,
  collectRulesDir,
  findProjectRoot,
} from "./src/discovery.js";
import { makeFs } from "./test-helpers.js";

describe("findProjectRoot", () => {
  it("anchors on a .git marker above cwd", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/pkg/AGENTS.md": "x",
    });
    expect(findProjectRoot("/proj/pkg", fs)).toBe("/proj");
  });

  it("falls back to cwd when no marker is found", () => {
    const fs = makeFs({ "/a/b/AGENTS.md": "x" });
    expect(findProjectRoot("/a/b", fs)).toBe("/a/b");
  });
});

describe("ancestorChain", () => {
  it("lists root -> cwd inclusive, root first", () => {
    expect(ancestorChain("/proj", "/proj/a/b")).toEqual([
      "/proj",
      "/proj/a",
      "/proj/a/b",
    ]);
  });
});

describe("collectRulesDir", () => {
  it("recursively collects *.md, sorted, ignoring non-md", () => {
    const fs = makeFs({
      "/r/rules/a.md": "1",
      "/r/rules/b.txt": "2",
      "/r/rules/sub/c.md": "3",
    });
    expect(collectRulesDir("/r/rules", fs)).toEqual([
      "/r/rules/a.md",
      "/r/rules/sub/c.md",
    ]);
  });

  it("returns [] when the directory is absent", () => {
    const fs = makeFs({ "/r/other.md": "1" });
    expect(collectRulesDir("/r/rules", fs)).toEqual([]);
  });
});

describe("collectLayers", () => {
  it("collects both AGENTS.md and CLAUDE.md in the same directory", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/AGENTS.md": "agents",
      "/proj/CLAUDE.md": "claude",
    });
    const layers = collectLayers({ cwd: "/proj", home: "/home/u", fs });
    const paths = layers.map((l) => l.path);
    expect(paths).toContain("/proj/AGENTS.md");
    expect(paths).toContain("/proj/CLAUDE.md");
    expect(layers.every((l) => l.layer === "project")).toBe(true);
  });

  it("collects .claude/rules recursively at project level", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/.claude/rules/style.md": "be terse",
      "/proj/.claude/rules/nested/api.md": "api rules",
    });
    const layers = collectLayers({ cwd: "/proj", home: "/home/u", fs });
    const paths = layers.map((l) => l.path);
    expect(paths).toContain("/proj/.claude/rules/style.md");
    expect(paths).toContain("/proj/.claude/rules/nested/api.md");
  });

  it("collects the user layer from ~/.claude and ~/.pi/rules", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/home/u/.claude/CLAUDE.md": "user claude",
      "/home/u/.claude/rules/x.md": "user rule",
      "/home/u/.pi/rules/y.md": "pi rule",
    });
    const layers = collectLayers({ cwd: "/proj", home: "/home/u", fs });
    const user = layers.filter((l) => l.layer === "user").map((l) => l.path);
    expect(user).toContain("/home/u/.claude/CLAUDE.md");
    expect(user).toContain("/home/u/.claude/rules/x.md");
    expect(user).toContain("/home/u/.pi/rules/y.md");
  });

  it("collects the local override layer", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/CLAUDE.local.md": "local secrets",
      "/proj/AGENTS.override.md": "override",
    });
    const layers = collectLayers({ cwd: "/proj", home: "/home/u", fs });
    const local = layers.filter((l) => l.layer === "local").map((l) => l.path);
    expect(local).toContain("/proj/CLAUDE.local.md");
    expect(local).toContain("/proj/AGENTS.override.md");
  });

  it("collects context files at every level between root and cwd", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/AGENTS.md": "root",
      "/proj/pkg/AGENTS.md": "pkg",
    });
    const layers = collectLayers({ cwd: "/proj/pkg", home: "/home/u", fs });
    const paths = layers.map((l) => l.path);
    expect(paths).toContain("/proj/AGENTS.md");
    expect(paths).toContain("/proj/pkg/AGENTS.md");
  });

  it("captures conditional globs from frontmatter", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/.claude/rules/api.md": "---\npaths: src/**\n---\napi guidance",
    });
    const layers = collectLayers({ cwd: "/proj", home: "/home/u", fs });
    const rule = layers.find((l) => l.path.endsWith("api.md"));
    expect(rule?.globs).toEqual(["src/**"]);
    expect(rule?.content).toContain("api guidance");
    expect(rule?.content).not.toContain("paths:");
  });
});
