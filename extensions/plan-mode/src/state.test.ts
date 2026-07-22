import { beforeEach, describe, expect, it } from "vitest";
import {
	enterPlan,
	exitPlan,
	getState,
	PLAN_STATE_ENTRY,
	restoreStateFromBranch,
	setState,
	type PlanModeState,
} from "./state.js";

function customEntry(data: unknown) {
	return { type: "custom", customType: PLAN_STATE_ENTRY, data };
}

beforeEach(() => {
	// Reset the module-level singleton between tests.
	exitPlan();
});

describe("enterPlan / exitPlan", () => {
	it("records pre-plan tools on enter and clears on exit", () => {
		enterPlan(["read", "grep", "bash"]);
		const entered = getState();
		expect(entered.enabled).toBe(true);
		expect(entered.prePlanActiveTools).toEqual(["read", "grep", "bash"]);

		exitPlan();
		const exited = getState();
		expect(exited.enabled).toBe(false);
		expect(exited.prePlanActiveTools).toEqual([]);
	});

	it("returns copies so external mutation does not leak into state", () => {
		enterPlan(["read"]);
		const snap = getState();
		snap.prePlanActiveTools.push("write");
		expect(getState().prePlanActiveTools).toEqual(["read"]);
	});

	it("setState replaces the current state", () => {
		const next: PlanModeState = { enabled: true, prePlanActiveTools: ["ls"] };
		setState(next);
		expect(getState()).toEqual(next);
	});
});

describe("restoreStateFromBranch", () => {
	it("returns the most recent valid state entry", () => {
		const first = { enabled: true, prePlanActiveTools: ["read"] };
		const second = { enabled: false, prePlanActiveTools: ["read", "bash"] };
		const branch = [customEntry(first), { type: "message" }, customEntry(second)];
		expect(restoreStateFromBranch(branch as Iterable<unknown>)).toEqual(second);
	});

	it("ignores invalid data and non-matching entries", () => {
		const good = { enabled: true, prePlanActiveTools: ["read"] };
		const branch = [
			customEntry(good),
			customEntry({ enabled: "nope" }),
			customEntry(null),
			{ type: "custom", customType: "other", data: { enabled: false, prePlanActiveTools: [] } },
		];
		expect(restoreStateFromBranch(branch as Iterable<unknown>)).toEqual(good);
	});

	it("coerces missing / non-string tool entries", () => {
		const branch = [customEntry({ enabled: true, prePlanActiveTools: ["read", 5, null, "bash"] })];
		expect(restoreStateFromBranch(branch as Iterable<unknown>)).toEqual({
			enabled: true,
			prePlanActiveTools: ["read", "bash"],
		});
	});

	it("defaults tools to [] when field is absent", () => {
		const branch = [customEntry({ enabled: true })];
		expect(restoreStateFromBranch(branch as Iterable<unknown>)).toEqual({ enabled: true, prePlanActiveTools: [] });
	});

	it("returns null when there is no matching entry", () => {
		expect(restoreStateFromBranch([{ type: "message" }] as Iterable<unknown>)).toBeNull();
		expect(restoreStateFromBranch([] as Iterable<unknown>)).toBeNull();
	});
});
