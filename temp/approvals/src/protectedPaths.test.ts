import { describe, it, expect } from "vitest";
import {
  checkTargets,
  DEFAULT_PROTECTED,
  expandHome,
  globToRegExp,
  isProtectedPath,
  resolvePath,
} from "./protectedPaths.js";

const CTX = { cwd: "/repo", home: "/home/me", protectedPatterns: DEFAULT_PROTECTED };

describe("globToRegExp", () => {
  it("** matches any depth including zero segments", () => {
    const re = globToRegExp("**/.git/config");
    expect(re.test(".git/config")).toBe(true);
    expect(re.test("a/b/.git/config")).toBe(true);
  });

  it("* stays within a segment", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a/b.ts")).toBe(false);
  });
});

describe("resolvePath", () => {
  it("resolves relative against cwd", () => {
    expect(resolvePath("src/x.ts", CTX)).toBe("/repo/src/x.ts");
  });
  it("expands ~", () => {
    expect(resolvePath("~/.ssh/id_rsa", CTX)).toBe("/home/me/.ssh/id_rsa");
  });
  it("collapses ..", () => {
    expect(resolvePath("a/../b", CTX)).toBe("/repo/b");
  });
});

describe("expandHome", () => {
  it("expands ~ in patterns", () => {
    expect(expandHome(["~/.ssh/**"], "/home/me")).toEqual(["/home/me/.ssh/**"]);
  });
});

describe("isProtectedPath", () => {
  it("protects .git/hooks", () => {
    expect(isProtectedPath(".git/hooks/pre-commit", CTX).protected).toBe(true);
  });
  it("protects .git/config", () => {
    expect(isProtectedPath(".git/config", CTX).protected).toBe(true);
  });
  it("protects .pi dir", () => {
    expect(isProtectedPath(".pi/session.json", CTX).protected).toBe(true);
  });
  it("protects ~/.ssh via home expansion", () => {
    expect(isProtectedPath("~/.ssh/id_rsa", CTX).protected).toBe(true);
    expect(isProtectedPath("/home/me/.ssh/known_hosts", CTX).protected).toBe(true);
  });
  it("protects .github/workflows", () => {
    expect(isProtectedPath(".github/workflows/ci.yml", CTX).protected).toBe(true);
  });
  it("allows ordinary source files", () => {
    expect(isProtectedPath("src/index.ts", CTX).protected).toBe(false);
    expect(isProtectedPath("README.md", CTX).protected).toBe(false);
  });
});

describe("checkTargets", () => {
  it("returns first protected match", () => {
    const m = checkTargets(["a.txt", ".git/config"], CTX);
    expect(m.protected).toBe(true);
    expect(m.matched).toBe("/repo/.git/config");
  });
  it("clean when nothing protected", () => {
    expect(checkTargets(["a.txt", "b.txt"], CTX).protected).toBe(false);
  });
});
