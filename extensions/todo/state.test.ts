import { describe, expect, it } from "vitest";
import {
  clearPlan,
  getPlan,
  hasInProgress,
  hasUnfinishedPlan,
  planCounts,
  restorePlanFromBranch,
  setPlan,
  shouldShowRestoredOverlay,
} from "./state.js";
import type { PlanSnapshot } from "./schema.js";

function custom(data: unknown) {
  return { type: "custom", customType: "codex-plan", data };
}

function snapshot(plan: PlanSnapshot["plan"]): PlanSnapshot {
  return { plan, updatedAt: 10 };
}

describe("todo state", () => {
  it("stores and clears the current plan", () => {
    const plan = snapshot([{ step: "A", status: "pending" }]);
    setPlan(plan);
    expect(getPlan()).toEqual(plan);
    clearPlan();
    expect(getPlan()).toBeNull();
  });

  it("restores the last valid codex-plan entry from a branch", () => {
    const first = snapshot([{ step: "Old", status: "pending" }]);
    const second = snapshot([{ step: "New", status: "in_progress" }]);

    expect(restorePlanFromBranch([custom(first), custom({ bad: true }), { type: "message" }, custom(second)] as any)).toEqual(
      second,
    );
  });

  it("returns null when no valid plan exists", () => {
    expect(restorePlanFromBranch([{ type: "message" }, custom({ plan: [{ step: "A", status: "bad" }] })] as any)).toBeNull();
  });

  it("detects unfinished and in-progress plans", () => {
    expect(hasUnfinishedPlan(snapshot([]))).toBe(false);
    expect(hasUnfinishedPlan(snapshot([{ step: "Done", status: "completed" }]))).toBe(false);
    expect(hasUnfinishedPlan(snapshot([{ step: "Todo", status: "pending" }]))).toBe(true);
    expect(hasUnfinishedPlan(snapshot([{ step: "Doing", status: "in_progress" }]))).toBe(true);
    expect(hasInProgress(snapshot([{ step: "Doing", status: "in_progress" }]))).toBe(true);
  });

  it("counts completed and total plan items", () => {
    expect(
      planCounts(
        snapshot([
          { step: "A", status: "completed" },
          { step: "B", status: "pending" },
        ]),
      ),
    ).toEqual({ completed: 1, total: 2 });
  });

  it("shows restored overlays only for unfinished plans", () => {
    expect(shouldShowRestoredOverlay(snapshot([{ step: "A", status: "pending" }]))).toBe(true);
    expect(shouldShowRestoredOverlay(snapshot([{ step: "A", status: "completed" }]))).toBe(false);
    expect(shouldShowRestoredOverlay(null)).toBe(false);
  });
});
