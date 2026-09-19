import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerChildReaper,
  unregisterChildReaper,
  reapChildrenOf,
  _resetChildReapersForTest,
} from "./childReaper.js";

beforeEach(() => {
  _resetChildReapersForTest();
});

afterEach(() => {
  _resetChildReapersForTest();
});

/**
 * Regression context: store traversal (`reapOwnedTasks`) cannot reach a
 * teammate's background children, because the teammate's own session has its
 * OWN tasks extension instance — so `async_bash` registers into a different
 * TaskStore object than the leader-side reaper reads. Measured on a real
 * teammate:
 *
 *   [async:DIAG] POST-REGISTER tag=store-76c9dr keys=["bq35gzimt"]
 *   [killTeammate:DIAG] sameStore=true killTag=<none>   // different object
 *   [killTeammate:DIAG] reapOwnedTasks -> []
 *
 * These process-global reapers are what actually reach the children.
 */
describe("child reapers", () => {
  it("returns 0 when nothing is registered", async () => {
    expect(await reapChildrenOf("a@t")).toBe(0);
  });

  it("asks the registered reaper for the right agent", async () => {
    const reaper = vi.fn(async () => 2);
    registerChildReaper("async", reaper);
    expect(await reapChildrenOf("a@t")).toBe(2);
    expect(reaper).toHaveBeenCalledWith("a@t");
  });

  it("sums attempts across multiple extensions", async () => {
    registerChildReaper("async", async () => 1);
    registerChildReaper("localshell", async () => 3);
    expect(await reapChildrenOf("a@t")).toBe(4);
  });

  it("re-registering the same key replaces (no double counting on reload)", async () => {
    registerChildReaper("async", async () => 1);
    registerChildReaper("async", async () => 5);
    expect(await reapChildrenOf("a@t")).toBe(5);
  });

  it("a throwing reaper does not stop the others", async () => {
    registerChildReaper("async", async () => {
      throw new Error("realm gone");
    });
    registerChildReaper("localshell", async () => 2);
    expect(await reapChildrenOf("a@t")).toBe(2);
  });

  it("unregister removes a reaper", async () => {
    registerChildReaper("async", async () => 1);
    unregisterChildReaper("async");
    expect(await reapChildrenOf("a@t")).toBe(0);
  });

  it("ignores a reaper that returns a non-finite count", async () => {
    registerChildReaper("async", async () => Number.NaN);
    expect(await reapChildrenOf("a@t")).toBe(0);
  });
});
