import { describe, expect, it } from "vitest";
import { buildInjection } from "./src/merge.js";
import type { DiscoveredFile } from "./src/types.js";

const base = "/proj";

function file(
  path: string,
  content: string,
  layer: DiscoveredFile["layer"],
  globs?: string[],
): DiscoveredFile {
  return { path, content, layer, globs };
}

function fresh() {
  return { unconditional: false, conditionalPaths: new Set<string>() };
}

describe("buildInjection dedup", () => {
  it("drops files pi already loaded", () => {
    const layers = [
      file("/proj/AGENTS.md", "PROJECT AGENTS", "project"),
      file("/proj/CLAUDE.md", "PROJECT CLAUDE", "project"),
    ];
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(["/proj/AGENTS.md"]),
      touchedPaths: new Set(),
      alreadyInjected: fresh(),
      baseDir: base,
    });
    expect(res.content).toContain("PROJECT CLAUDE");
    expect(res.content).not.toContain("PROJECT AGENTS");
  });
});

describe("buildInjection ordering", () => {
  it("orders user -> project -> local", () => {
    const layers = [
      file("/proj/CLAUDE.local.md", "LOCAL", "local"),
      file("/home/u/.claude/CLAUDE.md", "USER", "user"),
      file("/proj/AGENTS.md", "PROJECT", "project"),
    ];
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(),
      alreadyInjected: fresh(),
      baseDir: base,
    });
    const c = res.content ?? "";
    expect(c.indexOf("USER")).toBeLessThan(c.indexOf("PROJECT"));
    expect(c.indexOf("PROJECT")).toBeLessThan(c.indexOf("LOCAL"));
  });
});

describe("buildInjection unconditional latch", () => {
  it("injects unconditional content only once", () => {
    const layers = [file("/proj/AGENTS.md", "ONCE", "project")];
    const latch = fresh();
    const first = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(),
      alreadyInjected: latch,
      baseDir: base,
    });
    expect(first.content).toContain("ONCE");
    expect(first.newlyInjectedUnconditional).toBe(true);
    latch.unconditional = true;

    const second = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(),
      alreadyInjected: latch,
      baseDir: base,
    });
    expect(second.content).toBeNull();
  });
});

describe("buildInjection conditional rules", () => {
  const layers = [
    file("/proj/.claude/rules/api.md", "API RULE", "project", ["src/api/**"]),
  ];

  it("does not inject a conditional rule when nothing matches", () => {
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(["/proj/docs/readme.md"]),
      alreadyInjected: fresh(),
      baseDir: base,
    });
    expect(res.content).toBeNull();
  });

  it("injects a conditional rule when a touched path matches", () => {
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(["/proj/src/api/handler.ts"]),
      alreadyInjected: fresh(),
      baseDir: base,
    });
    expect(res.content).toContain("API RULE");
    expect(res.content).toContain("matched: src/api/handler.ts");
    expect(res.newlyInjectedConditionalPaths).toContain(
      "/proj/.claude/rules/api.md",
    );
  });

  it("injects a matched conditional rule only once (dedup)", () => {
    const latch = fresh();
    const first = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(["/proj/src/api/handler.ts"]),
      alreadyInjected: latch,
      baseDir: base,
    });
    expect(first.content).toContain("API RULE");
    for (const p of first.newlyInjectedConditionalPaths) {
      latch.conditionalPaths.add(p);
    }
    const second = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(["/proj/src/api/handler.ts"]),
      alreadyInjected: latch,
      baseDir: base,
    });
    expect(second.content).toBeNull();
  });
});

describe("buildInjection budget + provenance", () => {
  it("truncates over-budget files and flags them in provenance", () => {
    const big = "x".repeat(200);
    const layers = [file("/proj/AGENTS.md", big, "project")];
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(),
      alreadyInjected: fresh(),
      baseDir: base,
      maxBytes: 64,
    });
    expect(res.content).toContain("truncated");
    expect(res.content).toContain("from /proj/AGENTS.md");
    expect(res.content).toContain("layer: project");
  });

  it("emits a provenance header for each file", () => {
    const layers = [file("/proj/AGENTS.md", "BODY", "project")];
    const res = buildInjection({
      layers,
      piLoadedPaths: new Set(),
      touchedPaths: new Set(),
      alreadyInjected: fresh(),
      baseDir: base,
    });
    expect(res.content).toContain("<!-- from /proj/AGENTS.md, layer: project -->");
  });
});
