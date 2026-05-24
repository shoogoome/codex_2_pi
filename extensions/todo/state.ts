import { PLAN_CUSTOM_ENTRY, normalizePlanSnapshot, type PlanSnapshot } from "./schema.js";

let currentPlan: PlanSnapshot | null = null;

export function setPlan(snapshot: PlanSnapshot | null): void {
  currentPlan = snapshot;
}

export function getPlan(): PlanSnapshot | null {
  return currentPlan;
}

export function clearPlan(): void {
  currentPlan = null;
}

export function restorePlanFromBranch(branch: Iterable<unknown>): PlanSnapshot | null {
  let latest: PlanSnapshot | null = null;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PLAN_CUSTOM_ENTRY) continue;
    try {
      latest = normalizePlanSnapshot(entry.data);
    } catch {
      continue;
    }
  }
  return latest;
}

export function hasUnfinishedPlan(snapshot: PlanSnapshot | null): boolean {
  return !!snapshot?.plan.some((item) => item.status === "pending" || item.status === "in_progress");
}

export function hasInProgress(snapshot: PlanSnapshot | null): boolean {
  return !!snapshot?.plan.some((item) => item.status === "in_progress");
}

export function planCounts(snapshot: PlanSnapshot | null): { completed: number; total: number } {
  const plan = snapshot?.plan ?? [];
  return {
    completed: plan.filter((item) => item.status === "completed").length,
    total: plan.length,
  };
}

export function shouldShowRestoredOverlay(snapshot: PlanSnapshot | null): boolean {
  return hasUnfinishedPlan(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
