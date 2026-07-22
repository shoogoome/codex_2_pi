import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	buildContinuationPrompt,
	computeEffectiveBudget,
	DEFAULT_MAX_TURNS,
	DEFAULT_MIN_DELTA,
	DEFAULT_WINDOW,
	evaluateStop,
	parseCommandArgs,
	parseNumericFlag,
	type StopReason,
	shouldClearPending,
} from "./src/decide.js";

const CONTINUATION_CUSTOM_TYPE = "autopilot-continuation";
const STATUS_KEY = "autopilot";
const OBJECTIVE_STATUS_MAX = 48;

const FLAG_BUDGET = "autopilot-budget";
const FLAG_MAX_TURNS = "autopilot-max-turns";
const FLAG_MIN_DELTA = "autopilot-min-delta";
const FLAG_WINDOW = "autopilot-window";

/**
 * Autopilot: a runtime self-continuation controller, off by default.
 *
 * Mechanism (verified): `turn_end` fires DURING streaming, so the decide +
 * enqueue path is fully SYNCHRONOUS — `getContextUsage()` is sync and no `await`
 * runs before `sendMessage`. When we should continue we inject a hidden
 * follow-up (`deliverAs:"followUp"`); the host delivers it only once the agent
 * has no more tool calls / steering, which launches the next round. `agent_end`
 * is too late to enqueue a follow-up, so it is intentionally not used.
 */
export default function autopilotExtension(pi: ExtensionAPI): void {
	// In-memory closure state. Session restart resets to off, which is
	// acceptable because the default is off (no accidental auto-run on reload).
	let enabled = false;
	let objective: string | undefined;
	let turnsRun = 0;
	let tokenHistory: number[] = [];
	// Anti-stacking guard: at most one autopilot follow-up may be in flight.
	let pendingFollowUp = false;
	let injectedTurnIndex = -1;

	pi.registerFlag(FLAG_BUDGET, {
		description: "Token budget before autopilot stops (defaults to 90% of the context window).",
		type: "string",
	});
	pi.registerFlag(FLAG_MAX_TURNS, {
		description: `Maximum autonomous rounds before autopilot stops (default ${DEFAULT_MAX_TURNS}).`,
		type: "string",
	});
	pi.registerFlag(FLAG_MIN_DELTA, {
		description: `Per-turn token growth below which autopilot treats progress as diminishing (default ${DEFAULT_MIN_DELTA}).`,
		type: "string",
	});
	pi.registerFlag(FLAG_WINDOW, {
		description: `Number of recent turns whose deltas must all be below the min-delta to stop (default ${DEFAULT_WINDOW}).`,
		type: "string",
	});

	function readConfig(): {
		tokenBudget?: number;
		maxTurns: number;
		minDelta: number;
		window: number;
	} {
		const tokenBudget = parseNumericFlag(pi.getFlag(FLAG_BUDGET));
		const maxTurns = parseNumericFlag(pi.getFlag(FLAG_MAX_TURNS)) ?? DEFAULT_MAX_TURNS;
		const minDelta = parseNumericFlag(pi.getFlag(FLAG_MIN_DELTA)) ?? DEFAULT_MIN_DELTA;
		const window = parseNumericFlag(pi.getFlag(FLAG_WINDOW)) ?? DEFAULT_WINDOW;
		return { ...(tokenBudget !== undefined ? { tokenBudget } : {}), maxTurns, minDelta, window };
	}

	function activeStatusLine(): string | undefined {
		if (!enabled) return undefined;
		if (!objective) return `Autopilot on (turn ${turnsRun})`;
		const trimmed =
			objective.length > OBJECTIVE_STATUS_MAX ? `${objective.slice(0, OBJECTIVE_STATUS_MAX - 1)}…` : objective;
		return `Autopilot on (turn ${turnsRun}) — ${trimmed}`;
	}

	function stoppedStatusLine(reason: StopReason): string | undefined {
		if (reason === "budget") return "Autopilot stopped: token budget reached";
		if (reason === "max_turns") return "Autopilot stopped: max turns reached";
		if (reason === "diminishing") return "Autopilot stopped: diminishing returns";
		return undefined;
	}

	function setActiveStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, activeStatusLine());
	}

	function resetState(): void {
		turnsRun = 0;
		tokenHistory = [];
		pendingFollowUp = false;
		injectedTurnIndex = -1;
	}

	pi.registerCommand("autopilot", {
		description: "Toggle autonomous self-continuation: /autopilot on [objective] | off | status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseCommandArgs(args);
			if (parsed.action === "on") {
				enabled = true;
				objective = parsed.objective;
				resetState();
				setActiveStatus(ctx);
				ctx.ui.notify(
					objective ? `Autopilot on — objective: ${objective}` : "Autopilot on",
					"info",
				);
				return;
			}
			if (parsed.action === "off") {
				enabled = false;
				objective = undefined;
				resetState();
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Autopilot off", "info");
				return;
			}
			// status (or empty / unrecognized): report current state without changing it.
			if (!enabled) {
				ctx.ui.notify("Autopilot is off. Use /autopilot on [objective] to enable.", "info");
				return;
			}
			const cfg = readConfig();
			const parts = [
				`turns run: ${turnsRun}`,
				`max turns: ${cfg.maxTurns}`,
				`min delta: ${cfg.minDelta}`,
				`window: ${cfg.window}`,
				cfg.tokenBudget !== undefined ? `token budget: ${cfg.tokenBudget}` : "token budget: 90% of window",
				objective ? `objective: ${objective}` : "objective: (none)",
			];
			ctx.ui.notify(`Autopilot on — ${parts.join("; ")}`, "info");
		},
	});

	pi.on("turn_start", async (event) => {
		// A follow-up we injected is consumed once a later turn actually starts.
		if (shouldClearPending(pendingFollowUp, event.turnIndex, injectedTurnIndex)) {
			pendingFollowUp = false;
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled) return;

		// SYNC hot path: getContextUsage is sync; do not await before enqueuing.
		let tokens: number | null = null;
		let contextWindow = 0;
		try {
			const usage = ctx.getContextUsage();
			if (usage) {
				tokens = usage.tokens;
				contextWindow = usage.contextWindow;
			}
		} catch {
			// Treat a failed read as unknown usage.
			tokens = null;
		}

		// Only append to history when tokens are known; a post-compaction null
		// would otherwise masquerade as a diminishing-returns delta drop.
		if (tokens !== null) tokenHistory.push(tokens);
		// Count every completed round (including injected continuations) so
		// max-turns bounds total autonomous rounds.
		turnsRun += 1;

		const cfg = readConfig();
		const decision = evaluateStop({
			enabled,
			tokens,
			contextWindow,
			...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
			turnsRun,
			maxTurns: cfg.maxTurns,
			tokenHistory,
			minDelta: cfg.minDelta,
			window: cfg.window,
		});

		if (decision.stop) {
			// Auto-stop: disable the loop, clear the guard, surface the reason.
			enabled = false;
			pendingFollowUp = false;
			injectedTurnIndex = -1;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, stoppedStatusLine(decision.reason));
			return;
		}

		// Do not stack: only one follow-up in flight, and never when other
		// messages are already queued.
		if (pendingFollowUp) {
			setActiveStatus(ctx);
			return;
		}
		let hasPending = false;
		try {
			hasPending = ctx.hasPendingMessages();
		} catch {
			hasPending = false;
		}
		if (hasPending) {
			setActiveStatus(ctx);
			return;
		}

		const budget = computeEffectiveBudget(cfg.tokenBudget, contextWindow);
		const tokensUsed = tokens ?? 0;
		const prompt = buildContinuationPrompt({
			...(objective !== undefined ? { objective } : {}),
			tokensUsed,
			budget,
			remaining: Math.max(0, budget - tokensUsed),
		});

		pendingFollowUp = true;
		injectedTurnIndex = event.turnIndex;
		try {
			pi.sendMessage(
				{ customType: CONTINUATION_CUSTOM_TYPE, content: prompt, display: false },
				{ deliverAs: "followUp" },
			);
		} catch {
			// Enqueue failed: release the guard so a later turn can retry.
			pendingFollowUp = false;
			injectedTurnIndex = -1;
		}
		setActiveStatus(ctx);
	});
}
