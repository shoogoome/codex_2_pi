import { describe, expect, it } from "vitest";
import { expandIncludes, MAX_INCLUDE_DEPTH } from "./src/include.js";
import { makeFs } from "./test-helpers.js";

const opts = (fs: ReturnType<typeof makeFs>, home = "/home/u") => ({
  fs,
  home,
});

describe("expandIncludes", () => {
  it("expands a relative @include", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "main\n@./extra.md\ntail",
      "/proj/extra.md": "EXTRA CONTENT",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).toContain("EXTRA CONTENT");
    expect(out).toContain("main");
    expect(out).toContain("tail");
  });

  it("resolves ~/ against home", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "see @~/global.md",
      "/home/u/global.md": "GLOBAL",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).toContain("GLOBAL");
  });

  it("resolves an absolute path", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "abs @/shared/rules.md",
      "/shared/rules.md": "ABS",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).toContain("ABS");
  });

  it("guards against cycles (A -> B -> A)", () => {
    const fs = makeFs({
      "/proj/A.md": "A body @./B.md",
      "/proj/B.md": "B body @./A.md",
    });
    const out = expandIncludes("/proj/A.md", fs.readFile("/proj/A.md"), opts(fs));
    expect(out).toContain("A body");
    expect(out).toContain("B body");
    // A must not be re-expanded inside B (only one "A body" occurrence).
    expect(out.match(/A body/g)?.length).toBe(1);
  });

  it("stops at max include depth", () => {
    const files: Record<string, string> = {};
    // Chain of depth > MAX_INCLUDE_DEPTH.
    const n = MAX_INCLUDE_DEPTH + 3;
    for (let i = 0; i <= n; i++) {
      files[`/proj/f${i}.md`] =
        i < n ? `level${i} @./f${i + 1}.md` : `level${i} DEEPEST`;
    }
    const fs = makeFs(files);
    const out = expandIncludes("/proj/f0.md", fs.readFile("/proj/f0.md"), opts(fs));
    expect(out).toContain("level0");
    // The deepest file beyond the depth cap is not inlined.
    expect(out).not.toContain("DEEPEST");
  });

  it("does not expand @refs inside fenced code blocks", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "text\n```\n@./secret.md\n```\nmore",
      "/proj/secret.md": "SHOULD NOT APPEAR",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).not.toContain("SHOULD NOT APPEAR");
  });

  it("does not expand @refs inside inline code", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "use `@./inline.md` literally",
      "/proj/inline.md": "SHOULD NOT APPEAR",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).not.toContain("SHOULD NOT APPEAR");
  });

  it("strips a #fragment before resolving", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "jump @./doc.md#section",
      "/proj/doc.md": "DOC BODY",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).toContain("DOC BODY");
  });

  it("silently ignores missing targets", () => {
    const fs = makeFs({ "/proj/AGENTS.md": "ref @./nope.md end" });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).toContain("ref");
    expect(out).toContain("end");
  });

  it("ignores non-text extensions", () => {
    const fs = makeFs({
      "/proj/AGENTS.md": "img @./pic.png here",
      "/proj/pic.png": "binary",
    });
    const out = expandIncludes("/proj/AGENTS.md", fs.readFile("/proj/AGENTS.md"), opts(fs));
    expect(out).not.toContain("binary");
  });
});
