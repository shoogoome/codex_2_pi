import { describe, expect, it } from "vitest";
import { extractPaths, parseFrontmatter } from "./src/frontmatter.js";
import { globToRegExp, matchesAny } from "./src/glob.js";

describe("parseFrontmatter", () => {
  it("splits a leading --- block from the body", () => {
    const { frontmatter, content } = parseFrontmatter(
      "---\npaths: src/**\n---\nBODY",
    );
    expect(frontmatter.paths).toBe("src/**");
    expect(content).toBe("BODY");
  });

  it("returns whole input as content when there is no frontmatter", () => {
    const { frontmatter, content } = parseFrontmatter("no fm here");
    expect(frontmatter).toEqual({});
    expect(content).toBe("no fm here");
  });

  it("parses a YAML block list", () => {
    const parsed = parseFrontmatter(
      "---\npaths:\n  - src/**\n  - test/**\n---\nBODY",
    );
    expect(parsed.lists.paths).toEqual(["src/**", "test/**"]);
  });

  it("parses an inline flow list", () => {
    const parsed = parseFrontmatter('---\npaths: ["a/**", "b/**"]\n---\nBODY');
    expect(parsed.lists.paths).toEqual(["a/**", "b/**"]);
  });
});

describe("extractPaths", () => {
  it("parses a comma-separated string", () => {
    const parsed = parseFrontmatter("---\npaths: src/**, test/**\n---\nB");
    expect(extractPaths(parsed)).toEqual(["src/**", "test/**"]);
  });

  it("returns undefined when there is no paths key", () => {
    const parsed = parseFrontmatter("---\ntitle: x\n---\nB");
    expect(extractPaths(parsed)).toBeUndefined();
  });

  it("treats a catch-all ** as unconditional (undefined)", () => {
    const parsed = parseFrontmatter("---\npaths: **\n---\nB");
    expect(extractPaths(parsed)).toBeUndefined();
  });

  it("parses list form", () => {
    const parsed = parseFrontmatter(
      "---\npaths:\n  - src/**\n---\nB",
    );
    expect(extractPaths(parsed)).toEqual(["src/**"]);
  });
});

describe("globToRegExp", () => {
  it("** matches across directories", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/a.ts")).toBe(true);
  });

  it("a/**/b matches zero intermediate segments", () => {
    expect(globToRegExp("a/**/b.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/**/b.ts").test("a/x/y/b.ts")).toBe(true);
  });

  it("* stays within a single segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("? matches a single non-separator char", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a.b+c").test("a.b+c")).toBe(true);
    expect(globToRegExp("a.b+c").test("axbxc")).toBe(false);
  });
});

describe("matchesAny", () => {
  it("matches when any glob matches", () => {
    expect(matchesAny("src/index.ts", ["docs/**", "src/**"])).toBe(true);
  });

  it("normalizes a leading ./", () => {
    expect(matchesAny("./src/a.ts", ["src/**"])).toBe(true);
  });

  it("rejects absolute and escaping paths", () => {
    expect(matchesAny("/etc/passwd", ["**"])).toBe(false);
    expect(matchesAny("../outside.ts", ["**"])).toBe(false);
  });

  it("normalizes windows separators", () => {
    expect(matchesAny("src\\a\\b.ts", ["src/**"])).toBe(true);
  });

  it("returns false for empty glob list", () => {
    expect(matchesAny("src/a.ts", [])).toBe(false);
  });
});
