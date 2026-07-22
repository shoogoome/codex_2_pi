import { describe, expect, it } from "vitest";
import {
	buildContinuationPrompt,
	computeEffectiveBudget,
	DEFAULT_BUDGET_FRACTION,
	evaluateStop,
	type EvaluateStopInput,
	parseCommandArgs,
	parseNumericFlag,
	recentDeltasBelowThreshold,
	shouldClearPending,
} from "./decide.js";

function baseInput(overrides: Partial<EvaluateStopInput> = {}): EvaluateStopInput {
	return {
		enabled: true,
		tokens: 1000,
		contextWindow: 200_000,
		turnsRun: 0,
		maxTurns: 25,
		tokenHistory: [],
		minDelta: 2000,
		window: 3,
		...overrides,
	};
}

describe("computeEffectiveBudget", () => {
	it("uses the explicit positive budget", () => {
		expect(computeEffectiveBudget(50_000, 200_000)).toBe(50_000);
		expect(computeEffectiveBudget(50_000.7, 200_000)).toBe(50_000);
	});

	it("falls back to fraction of the context window when no budget", () => {
		expect(computeEffectiveBudget(undefined, 200_000)).toBe(Math.floor(200_000 * DEFAULT_BUDGET_FRACTION));
		expect(computeEffectiveBudget(0, 100_000)).toBe(90_000);
		expect(computeEffectiveBudget(-5, 100_000)).toBe(90_000);
	});

	it("honors a custom fraction", () => {
		expect(computeEffectiveBudget(undefined, 100_000, 0.5)).toBe(50_000);
	});

	it("returns 0 when the window is unusable", () => {
		expect(computeEffectiveBudget(undefined, 0)).toBe(0);
	});
});

describe("recentDeltasBelowThreshold", () => {
	it("returns false when history is shorter than window+1", () => {
		expect(recentDeltasBelowThreshold([100, 200, 300], 3, 500)).toBe(false);
		expect(recentDeltasBelowThreshold([], 3, 500)).toBe(false);
	});

	it("is true when the last window deltas are all below minDelta", () => {
		// deltas of last 3: 100, 100, 100 (all < 500)
		expect(recentDeltasBelowThreshold([0, 5000, 5100, 5200, 5300], 3, 500)).toBe(true);
	});

	it("is false when any of the last window deltas meets or exceeds minDelta", () => {
		// last 3 deltas: 100, 900, 100 -> 900 >= 500
		expect(recentDeltasBelowThreshold([0, 100, 200, 1100, 1200], 3, 500)).toBe(false);
	});

	it("ignores older large deltas outside the window", () => {
		// history deltas overall: 9000, 100, 100, 100; window 3 => 100,100,100
		expect(recentDeltasBelowThreshold([0, 9000, 9100, 9200, 9300], 3, 500)).toBe(true);
	});

	it("returns false for a non-positive window", () => {
		expect(recentDeltasBelowThreshold([0, 1, 2, 3], 0, 500)).toBe(false);
	});
});

describe("evaluateStop", () => {
	it("stops immediately when disabled", () => {
		expect(evaluateStop(baseInput({ enabled: false }))).toEqual({ stop: true, reason: "disabled" });
	});

	it("continues when token usage is unknown (post-compaction)", () => {
		expect(evaluateStop(baseInput({ tokens: null, turnsRun: 999 }))).toEqual({ stop: false, reason: null });
	});

	it("stops on explicit budget", () => {
		expect(evaluateStop(baseInput({ tokens: 50_000, tokenBudget: 40_000 }))).toEqual({
			stop: true,
			reason: "budget",
		});
	});

	it("stops on the contextWindow*0.9 fallback budget", () => {
		expect(evaluateStop(baseInput({ tokens: 181_000, contextWindow: 200_000 }))).toEqual({
			stop: true,
			reason: "budget",
		});
	});

	it("does not stop on budget just under the fallback threshold", () => {
		expect(evaluateStop(baseInput({ tokens: 179_000, contextWindow: 200_000 }))).toEqual({
			stop: false,
			reason: null,
		});
	});

	it("stops when turnsRun reaches maxTurns (boundary)", () => {
		expect(evaluateStop(baseInput({ turnsRun: 25, maxTurns: 25 }))).toEqual({ stop: true, reason: "max_turns" });
	});

	it("does not stop one turn before maxTurns", () => {
		expect(evaluateStop(baseInput({ turnsRun: 24, maxTurns: 25 }))).toEqual({ stop: false, reason: null });
	});

	it("stops on diminishing returns", () => {
		expect(
			evaluateStop(
				baseInput({
					tokens: 5300,
					tokenHistory: [0, 5000, 5100, 5200, 5300],
					minDelta: 500,
					window: 3,
				}),
			),
		).toEqual({ stop: true, reason: "diminishing" });
	});

	it("does not stop when one recent delta exceeds minDelta", () => {
		expect(
			evaluateStop(
				baseInput({
					tokens: 1200,
					tokenHistory: [0, 100, 200, 1100, 1200],
					minDelta: 500,
					window: 3,
				}),
			),
		).toEqual({ stop: false, reason: null });
	});

	it("prefers budget over max_turns and diminishing", () => {
		expect(
			evaluateStop(
				baseInput({
					tokens: 50_000,
					tokenBudget: 40_000,
					turnsRun: 999,
					tokenHistory: [0, 100, 200, 300, 400],
					minDelta: 500,
					window: 3,
				}),
			),
		).toEqual({ stop: true, reason: "budget" });
	});
});

describe("shouldClearPending", () => {
	it("clears only when the current turn advanced past the injected turn", () => {
		expect(shouldClearPending(true, 5, 4)).toBe(true);
		expect(shouldClearPending(true, 4, 4)).toBe(false);
		expect(shouldClearPending(true, 3, 4)).toBe(false);
	});

	it("never clears when nothing is pending", () => {
		expect(shouldClearPending(false, 100, 0)).toBe(false);
	});
});

describe("parseCommandArgs", () => {
	it("returns null action for empty input", () => {
		expect(parseCommandArgs("")).toEqual({ action: null });
		expect(parseCommandArgs("   ")).toEqual({ action: null });
	});

	it("parses off and status", () => {
		expect(parseCommandArgs("off")).toEqual({ action: "off" });
		expect(parseCommandArgs("  STATUS ")).toEqual({ action: "status" });
	});

	it("parses on without an objective", () => {
		expect(parseCommandArgs("on")).toEqual({ action: "on" });
		expect(parseCommandArgs("ON   ")).toEqual({ action: "on" });
	});

	it("captures the objective text after on", () => {
		expect(parseCommandArgs("on refactor the parser and add tests")).toEqual({
			action: "on",
			objective: "refactor the parser and add tests",
		});
	});

	it("returns null action for unknown verbs", () => {
		expect(parseCommandArgs("wat is this")).toEqual({ action: null });
	});
});

describe("parseNumericFlag", () => {
	it("parses valid numeric strings", () => {
		expect(parseNumericFlag("40000")).toBe(40_000);
		expect(parseNumericFlag(" 12 ")).toBe(12);
		expect(parseNumericFlag("0")).toBe(0);
	});

	it("returns undefined for invalid, empty, boolean, or missing values", () => {
		expect(parseNumericFlag("abc")).toBeUndefined();
		expect(parseNumericFlag("")).toBeUndefined();
		expect(parseNumericFlag("   ")).toBeUndefined();
		expect(parseNumericFlag(true)).toBeUndefined();
		expect(parseNumericFlag(undefined)).toBeUndefined();
	});
});

describe("buildContinuationPrompt", () => {
	it("embeds the objective and the numeric budget fields", () => {
		const prompt = buildContinuationPrompt({
			objective: "ship the autopilot extension",
			tokensUsed: 1234,
			budget: 180_000,
			remaining: 178_766,
		});
		expect(prompt).toContain("ship the autopilot extension");
		expect(prompt).toContain("Tokens used: 1234");
		expect(prompt).toContain("Token budget: 180000");
		expect(prompt).toContain("Tokens remaining: 178766");
		expect(prompt).toContain("<objective>");
	});

	it("omits the objective block when no objective is given", () => {
		const prompt = buildContinuationPrompt({ tokensUsed: 0, budget: 100, remaining: 100 });
		expect(prompt).not.toContain("<objective>");
		expect(prompt).toContain("Continue autonomously");
	});

	it("escapes angle brackets in the objective", () => {
		const prompt = buildContinuationPrompt({
			objective: "handle <tag> & </tag>",
			tokensUsed: 0,
			budget: 1,
			remaining: 1,
		});
		expect(prompt).toContain("handle &lt;tag&gt; &amp; &lt;/tag&gt;");
	});
});
