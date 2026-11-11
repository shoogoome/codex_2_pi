import { describe, expect, it } from "vitest";
import {
  createPlanState,
  hasInProgress,
  hasUnfinishedPlan,
  planCounts,
  restorePlanFromBranch,
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
    const state = createPlanState();
    state.setPlan(plan);
    expect(state.getPlan()).toEqual(plan);
    state.clearPlan();
    expect(state.getPlan()).toBeNull();
  });

  it("isolates stores created by the same cached module before any lifecycle events", () => {
    const root = createPlanState();
    const firstWorker = createPlanState();
    const secondWorker = createPlanState();
    const rootPlan = snapshot([{ step: "Root", status: "in_progress" }]);
    const firstPlan = snapshot([{ step: "Worker one", status: "pending" }]);
    const secondPlan = snapshot([{ step: "Worker two", status: "completed" }]);
    root.setPlan(rootPlan);
    firstWorker.setPlan(firstPlan);
    secondWorker.setPlan(secondPlan);
    expect(root.getPlan()).toBe(rootPlan);
    expect(firstWorker.getPlan()).toBe(firstPlan);
    expect(secondWorker.getPlan()).toBe(secondPlan);
    firstWorker.clearPlan();
    expect(firstWorker.getPlan()).toBeNull();
    expect(root.getPlan()).toBe(rootPlan);
    expect(secondWorker.getPlan()).toBe(secondPlan);
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
