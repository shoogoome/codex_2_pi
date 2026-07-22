/**
 * Plan-mode state: a small module-level singleton plus pure helpers for
 * persistence/restore. The pi API layer (index.ts) drives transitions; this
 * module only holds the flag + the pre-plan tool set and knows how to
 * round-trip that through session entries.
 */

/** Custom entry type used to persist plan-mode state in the session. */
export const PLAN_STATE_ENTRY = "plan-mode-state";

export interface PlanModeState {
	/** Whether plan mode is currently active. */
	enabled: boolean;
	/** Active tools captured when entering plan mode, restored on exit. */
	prePlanActiveTools: string[];
}

function freshState(): PlanModeState {
	return { enabled: false, prePlanActiveTools: [] };
}

let current: PlanModeState = freshState();

/** Current in-memory state (returns a copy to avoid external mutation). */
export function getState(): PlanModeState {
	return { enabled: current.enabled, prePlanActiveTools: [...current.prePlanActiveTools] };
}

/** Replace the in-memory state wholesale (used on restore). */
export function setState(state: PlanModeState): void {
	current = { enabled: state.enabled, prePlanActiveTools: [...state.prePlanActiveTools] };
}

/** Enter plan mode, recording the tools that were active beforehand. */
export function enterPlan(prePlanActiveTools: readonly string[]): PlanModeState {
	current = { enabled: true, prePlanActiveTools: [...prePlanActiveTools] };
	return getState();
}

/** Leave plan mode, clearing the recorded pre-plan tools. */
export function exitPlan(): PlanModeState {
	current = freshState();
	return getState();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize arbitrary persisted data into a PlanModeState, or throw. */
function normalizeState(data: unknown): PlanModeState {
	if (!isRecord(data)) throw new Error("invalid plan-mode state");
	if (typeof data.enabled !== "boolean") throw new Error("invalid plan-mode state: enabled");
	const raw = data.prePlanActiveTools;
	const tools = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
	return { enabled: data.enabled, prePlanActiveTools: tools };
}

/**
 * Scan a session branch for the most recent plan-mode-state custom entry and
 * return it, or null if none is valid. Mirrors todo/state.ts restore pattern.
 */
export function restoreStateFromBranch(branch: Iterable<unknown>): PlanModeState | null {
	let latest: PlanModeState | null = null;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
		try {
			latest = normalizeState(entry.data);
		} catch {
			continue;
		}
	}
	return latest;
}
