import { describe, expect, it } from "vitest";
import { buildInjection } from "./inject.js";
import type { RecalledTopic } from "./recall.js";

const recalled = (over: Partial<RecalledTopic> = {}): RecalledTopic => ({
  name: over.name ?? "Auth",
  path: over.path ?? "auth.md",
  type: over.type ?? "project",
  body: over.body ?? "- uses OAuth",
  truncated: over.truncated ?? false,
});

describe("buildInjection", () => {
  it("emits rules + index on an armed turn", () => {
    const out = buildInjection({
      memoryDir: "/repo/.pi/memory",
      indexPath: "/repo/.pi/memory/MEMORY.md",
      index: "# Memory index\n\n- `auth.md` — **Auth** (project): ...",
      recalled: [],
      includeRulesAndIndex: true,
    });
    expect(out).not.toBeNull();
    expect(out).toContain("Long-term memory");
    expect(out).toContain("/repo/.pi/memory");
    expect(out).toContain("## Memory index");
    expect(out).toContain("**Auth**");
  });

  it("shows _(empty)_ when the index is null/blank on an armed turn", () => {
    const out = buildInjection({
      memoryDir: "/m",
      indexPath: "/m/MEMORY.md",
      index: null,
      recalled: [],
      includeRulesAndIndex: true,
    });
    expect(out).toContain("## Memory index");
    expect(out).toContain("_(empty)_");
  });

  it("emits recall-only when not armed", () => {
    const out = buildInjection({
      memoryDir: "/m",
      indexPath: "/m/MEMORY.md",
      index: "ignored",
      recalled: [recalled({ name: "Auth", body: "- token flow" })],
      includeRulesAndIndex: false,
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain("Long-term memory");
    expect(out).not.toContain("## Memory index");
    expect(out).toContain("## Recalled memory");
    expect(out).toContain("### Auth (project) — `auth.md`");
    expect(out).toContain("- token flow");
  });

  it("returns null when nothing to inject", () => {
    expect(
      buildInjection({
        memoryDir: "/m",
        indexPath: "/m/MEMORY.md",
        index: "x",
        recalled: [],
        includeRulesAndIndex: false,
      }),
    ).toBeNull();
  });

  it("combines rules+index and recall on an armed turn with matches", () => {
    const out = buildInjection({
      memoryDir: "/m",
      indexPath: "/m/MEMORY.md",
      index: "# Memory index",
      recalled: [recalled()],
      includeRulesAndIndex: true,
    });
    expect(out).toContain("## Memory index");
    expect(out).toContain("## Recalled memory");
  });
});
