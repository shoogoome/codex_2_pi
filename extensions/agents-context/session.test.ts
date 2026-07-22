import { describe, expect, it } from "vitest";
import {
  AgentsContextSession,
  extractPiLoadedPaths,
} from "./src/session.js";
import { makeFs } from "./test-helpers.js";

describe("extractPiLoadedPaths", () => {
  it("collects string paths from systemPromptOptions.contextFiles", () => {
    const set = extractPiLoadedPaths({
      contextFiles: [
        { path: "/proj/AGENTS.md", content: "x" },
        { path: "/home/u/.pi/AGENTS.md", content: "y" },
      ],
    });
    expect(set.has("/proj/AGENTS.md")).toBe(true);
    expect(set.has("/home/u/.pi/AGENTS.md")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("tolerates undefined / malformed inputs", () => {
    expect(extractPiLoadedPaths(undefined).size).toBe(0);
    expect(extractPiLoadedPaths({}).size).toBe(0);
    expect(
      extractPiLoadedPaths({
        // path missing / wrong type / empty are all skipped.
        contextFiles: [{ content: "x" }, { path: 123 as unknown as string }, { path: "" }],
      }).size,
    ).toBe(0);
  });
});

describe("AgentsContextSession wiring", () => {
  it("does NOT re-inject a file pi already loaded (dedup via contextFiles)", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/AGENTS.md": "PROJECT AGENTS",
      "/proj/CLAUDE.md": "PROJECT CLAUDE",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();
    expect(session.hasLayers()).toBe(true);

    // pi already loaded AGENTS.md natively; only the net-new CLAUDE.md remains.
    const piLoaded = extractPiLoadedPaths({
      contextFiles: [{ path: "/proj/AGENTS.md", content: "PROJECT AGENTS" }],
    });
    const block = session.build(piLoaded);
    expect(block).toContain("PROJECT CLAUDE");
    expect(block).not.toContain("PROJECT AGENTS");
  });

  it("injects unconditional content exactly once across turns", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/CLAUDE.md": "SUPPLEMENTAL",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();

    const first = session.build(new Set());
    expect(first).toContain("SUPPLEMENTAL");
    // Second turn (no compaction): latch suppresses re-injection.
    const second = session.build(new Set());
    expect(second).toBeNull();
  });

  it("re-injects after a compaction latch reset", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/CLAUDE.md": "SUPPLEMENTAL",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();
    expect(session.build(new Set())).toContain("SUPPLEMENTAL");
    expect(session.build(new Set())).toBeNull();

    session.resetInjectionLatch();
    expect(session.build(new Set())).toContain("SUPPLEMENTAL");
  });

  it("gates a conditional rule on a touched path matching its globs", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/.claude/rules/api.md": "---\npaths: src/api/**\n---\nAPI RULE",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();

    // Nothing touched yet -> conditional rule stays out.
    expect(session.build(new Set())).toBeNull();

    // A read of an unrelated path does not trigger it.
    session.touch("/proj/docs/readme.md");
    expect(session.build(new Set())).toBeNull();

    // A matching touch injects it, and only once.
    session.touch("/proj/src/api/handler.ts");
    const injected = session.build(new Set());
    expect(injected).toContain("API RULE");
    expect(injected).toContain("matched: src/api/handler.ts");
    expect(session.build(new Set())).toBeNull();
  });

  it("start() clears touched + injection latches for a new session", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      "/proj/CLAUDE.md": "SUPPLEMENTAL",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();
    expect(session.build(new Set())).toContain("SUPPLEMENTAL");
    expect(session.build(new Set())).toBeNull();

    // A fresh session_start re-arms everything.
    session.start();
    expect(session.build(new Set())).toContain("SUPPLEMENTAL");
  });

  it("reports no layers when nothing supplemental exists", () => {
    const fs = makeFs({
      "/proj/.git/config": "",
      // Only a single AGENTS.md that pi itself would load — but discovery still
      // finds it; emptiness is asserted via build() dedup below instead.
      "/proj/AGENTS.md": "ONLY NATIVE",
    });
    const session = new AgentsContextSession({
      fs,
      cwd: "/proj",
      home: "/home/u",
    });
    session.start();
    // If pi loaded the sole file, there is nothing net-new to inject.
    const piLoaded = extractPiLoadedPaths({
      contextFiles: [{ path: "/proj/AGENTS.md", content: "ONLY NATIVE" }],
    });
    expect(session.build(piLoaded)).toBeNull();
  });
});
