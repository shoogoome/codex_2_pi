// extensions/cost-usage/src/snapshot.test.ts
//
// Unit tests for cross-session restore + snapshot build.

import { describe, expect, it } from "vitest";
import { buildSnapshot, restoreFromBranch } from "./snapshot.js";

const assistant = (model: string, stopReason: string, usage: Record<string, unknown>) => ({
  type: "message",
  message: { role: "assistant", model, stopReason, usage },
});

const customEntry = (data: unknown) => ({ type: "custom", customType: "cost-usage/snapshot", data });

describe("restoreFromBranch", () => {
  it("re-derives byModel from the branch (authoritative) and does NOT add snapshot byModel on top", () => {
    const branch = [
      assistant("a", "stop", { input: 10, output: 5, cacheRead: 80, cacheWrite: 0, totalTokens: 95, cost: { total: 0.1 } }),
      // A stale snapshot that ALSO claims byModel totals — must be ignored for byModel.
      customEntry({
        sessionId: "s1",
        byModel: { a: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, costTotal: 99, turns: 99, estimated: false } },
        lines: { added: 3, removed: 1, files: ["x.ts"] },
        startedAt: 500,
        lastActivityAt: 1500,
      }),
    ];
    const r = restoreFromBranch(branch, "s1");
    // byModel comes ONLY from branch re-derivation, not the snapshot's inflated numbers.
    expect(r.byModel.a.input).toBe(10);
    expect(r.byModel.a.costTotal).toBe(0.1);
    expect(r.byModel.a.turns).toBe(1);
    // lines + duration baseline come from the snapshot.
    expect(r.lines).toEqual({ added: 3, removed: 1, files: ["x.ts"] });
    expect(r.startedAt).toBe(500);
    expect(r.lastActivityAt).toBe(1500);
  });

  it("ignores snapshots scoped to a different session (fork/reload bleed)", () => {
    const branch = [
      customEntry({ sessionId: "other", lines: { added: 7, removed: 7, files: ["y.ts"] }, startedAt: 1, lastActivityAt: 2 }),
      customEntry({ sessionId: "s1", lines: { added: 2, removed: 1, files: ["z.ts"] }, startedAt: 100, lastActivityAt: 200 }),
    ];
    const r = restoreFromBranch(branch, "s1");
    expect(r.lines).toEqual({ added: 2, removed: 1, files: ["z.ts"] });
    expect(r.startedAt).toBe(100);
    expect(r.lastActivityAt).toBe(200);
  });

  it("takes the newest matching snapshot when several exist", () => {
    const branch = [
      customEntry({ sessionId: "s1", lines: { added: 1, removed: 0, files: [] }, startedAt: 10, lastActivityAt: 20 }),
      customEntry({ sessionId: "s1", lines: { added: 5, removed: 2, files: ["a", "b"] }, startedAt: 10, lastActivityAt: 99 }),
    ];
    const r = restoreFromBranch(branch, "s1");
    expect(r.lines.added).toBe(5);
    expect(r.lastActivityAt).toBe(99);
  });

  it("returns empties when there is no matching snapshot", () => {
    const r = restoreFromBranch([assistant("a", "stop", { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } })], "s1");
    expect(r.lines).toEqual({ added: 0, removed: 0, files: [] });
    expect(r.startedAt).toBe(0);
    expect(r.byModel.a.turns).toBe(1);
  });
});

describe("buildSnapshot", () => {
  it("assembles a persistable snapshot with defaults", () => {
    const s = buildSnapshot({ sessionId: "s1", now: 12345 });
    expect(s).toEqual({
      sessionId: "s1",
      byModel: {},
      lines: { added: 0, removed: 0, files: [] },
      startedAt: 0,
      lastActivityAt: 0,
      updatedAt: 12345,
    });
  });
});
