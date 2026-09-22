import { describe, expect, it } from "vitest";
import { MemorySession } from "./session.js";
import { makeFs } from "../test-helpers.js";

const AUTH = [
  "---",
  "name: Auth",
  "description: authentication and login flow",
  "type: project",
  "---",
  "- login uses OAuth tokens",
].join("\n");

const BUILD = [
  "---",
  "name: Build",
  "description: how to build and package",
  "type: project",
  "---",
  "- build with npm run compile",
].join("\n");

function repoFs() {
  return makeFs({
    "/repo/.git/HEAD": "ref",
    "/repo/.pi/memory/MEMORY.md": "# Memory index\n\n- `auth.md` — **Auth** (project): auth",
    "/repo/.pi/memory/auth.md": AUTH,
    "/repo/.pi/memory/build.md": BUILD,
  });
}

describe("MemorySession", () => {
  it("resolves the in-repo memory dir and loads topics", () => {
    const s = new MemorySession({ fs: repoFs(), cwd: "/repo/pkg", home: "/home/u" });
    s.start();
    expect(s.getMemoryDir()).toBe("/repo/.pi/memory");
    expect(s.getIndexPath()).toBe("/repo/.pi/memory/MEMORY.md");
    expect(s.hasMemory()).toBe(true);
    expect(s.getTopics().map((t) => t.name).sort()).toEqual(["Auth", "Build"]);
  });

  it("first turn injects rules + index (armed) and recalled matches", () => {
    const s = new MemorySession({ fs: repoFs(), cwd: "/repo", home: "/home/u" });
    s.start();
    const out = s.build("how does auth login work");
    expect(out).not.toBeNull();
    expect(out).toContain("Long-term memory");
    expect(out).toContain("## Memory index");
    expect(out).toContain("## Recalled memory");
    expect(out).toContain("Auth");
  });

  it("later turns are recall-only (no rules/index) and skip already-recalled topics", () => {
    const s = new MemorySession({ fs: repoFs(), cwd: "/repo", home: "/home/u" });
    s.start();
    s.build("auth"); // armed turn recalls Auth
    const out = s.build("how to build the project");
    expect(out).not.toBeNull();
    expect(out).not.toContain("## Memory index");
    expect(out).toContain("## Recalled memory");
    expect(out).toContain("Build");
    // Re-asking about auth injects nothing new (armed consumed, Auth recalled).
    expect(s.build("auth again")).toBeNull();
  });

  it("resetInjectionLatch re-arms rules + index even with no recall match", () => {
    const s = new MemorySession({ fs: repoFs(), cwd: "/repo", home: "/home/u" });
    s.start();
    s.build("auth");
    expect(s.build("zzz-nomatch-token")).toBeNull();
    s.resetInjectionLatch();
    const out = s.build("zzz-nomatch-token");
    expect(out).not.toBeNull();
    expect(out).toContain("## Memory index");
  });

  it("honors the per-session cumulative recall cap", () => {
    const s = new MemorySession({
      fs: repoFs(),
      cwd: "/repo",
      home: "/home/u",
      sessionCap: 1,
    });
    s.start();
    // Armed turn: rules+index present regardless, and one topic recalled.
    const first = s.build("auth build");
    expect(first).toContain("## Recalled memory");
    // Cap reached (1 topic) → next turn recalls nothing and is not armed → null.
    expect(s.build("build auth")).toBeNull();
  });

  it("returns null when the memory dir is empty / absent", () => {
    const fs = makeFs({ "/repo/.git/HEAD": "ref" });
    const s = new MemorySession({ fs, cwd: "/repo", home: "/home/u" });
    s.start();
    expect(s.hasMemory()).toBe(false);
    expect(s.build("anything")).toBeNull();
  });
});

it("does not consume recall for topic blocks excluded by a small dynamic budget", () => {
  const s = new MemorySession({ fs: repoFs(), cwd: "/repo", home: "/home/u" });
  s.start();
  expect(s.build("auth", 0)).toBeNull();
  const tiny = s.build("auth", 200);
  expect(Buffer.byteLength(tiny!)).toBeLessThanOrEqual(200);
  expect(tiny).not.toContain("### Auth");
  expect(s.build("auth", 8000)).toContain("### Auth");
  s.resetInjectionLatch();
  expect(s.build("auth", 8000)).toContain("### Auth");
});
