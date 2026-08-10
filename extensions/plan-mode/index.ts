/**
 * Plan Mode Extension
 *
 * A read-only planning gate modeled on Claude's EnterPlanMode / ExitPlanModeV2:
 * explore only → submit a plan → user approves → resume with full tools.
 *
 * Entry points:
 * - `/plan`, `/plan on`, `/plan off` command (the reliable primary entry)
 * - a toggle shortcut, default `alt+p`, configurable via the
 *   `plan-mode-toggle-key` flag (toggles on/off)
 * - `--plan` flag (start a session directly in plan mode)
 *
 * The toggle shortcut default is `alt+p`, NOT `shift+tab`: pi binds `shift+tab`
 * to the built-in `app.thinking.cycle` (cycle thinking level), so registering
 * `shift+tab` here collides with the built-in and pi drops the extension
 * shortcut at startup ("conflicts with built-in shortcut. Skipping."). `alt+p`
 * is unused by any pi/pi-tui default binding. To reclaim `shift+tab` for plan
 * mode, rebind `app.thinking.cycle` in keybindings.json and set the flag to
 * `shift+tab`.
 *
 * While in plan mode:
 * - The active tool set is narrowed to read-only tools (write/edit/apply_patch
 *   removed; the exit tool added). bash stays active but write bash commands
 *   are blocked at runtime.
 * - The base system prompt is augmented with planning instructions.
 * - A footer status shows "⏸ plan mode on".
 *
 * Exit is by the model calling `exit_plan_mode` (confirmed by the user via a
 * dialog) or by the user running `/plan off`. On approval, the pre-plan tool
 * set is restored and the planning prompt is dropped.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { setAgentMutationPaused } from "../shared/agentMutationPause.js";
import {
	computeReadOnlyTools,
	EXIT_TOOL_NAME,
	isWriteBashCommand,
	isWriteTool,
	sanitizeToolNames,
} from "./src/guard.js";
import {
	EXIT_APPROVED_MESSAGE,
	EXIT_CONFIRM_TITLE,
	EXIT_REJECTED_MESSAGE,
	NOT_IN_PLAN_MESSAGE,
	PLAN_SYSTEM_PROMPT,
	exitConfirmBody,
	planStatusLabel,
} from "./src/prompt.js";
import {
	PLAN_STATE_ENTRY,
	enterPlan,
	exitPlan,
	getState,
	restoreStateFromBranch,
	setState,
	type PlanModeState,
} from "./src/state.js";

const STATUS_KEY = "plan-mode";

const TOGGLE_KEY_FLAG = "plan-mode-toggle-key";
/**
 * Default toggle key. `alt+p` is intentionally chosen over `shift+tab`:
 *   - `shift+tab` is already bound to `app.thinking.cycle` (cycle thinking
 *     level) by pi, so registering it here collides with the built-in and pi
 *     drops the extension shortcut at startup ("conflicts with built-in
 *     shortcut. Skipping.").
 *   - `alt+p` is unused by any pi/pi-tui default binding, and `alt+<letter>`
 *     sequences are emitted reliably across terminals (pi's own defaults use
 *     `alt+b`/`alt+f`/`alt+d`/`alt+y`).
 */
const DEFAULT_TOGGLE_KEY = "alt+p";

const ExitPlanParamsSchema = Type.Object(
	{
		plan: Type.String({
			description:
				"The finished implementation plan to present to the user for approval: which files change, what the changes are, and the order of steps.",
		}),
	},
	{ additionalProperties: false },
);
type ExitPlanParams = Static<typeof ExitPlanParamsSchema>;

export default function planModeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration and planning)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag(TOGGLE_KEY_FLAG, {
		type: "string",
		default: DEFAULT_TOGGLE_KEY,
		description:
			`Key that toggles plan mode (default "${DEFAULT_TOGGLE_KEY}"). ` +
			`Avoids the Shift+Tab binding pi reserves for app.thinking.cycle (cycle ` +
			`thinking level); see the plan-mode README to reclaim that key. ` +
			`A blank/unset value falls back to "${DEFAULT_TOGGLE_KEY}".`,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, planStatusLabel(getState().enabled));
	}

	function persist(): void {
		const state = getState();
		pi.appendEntry<PlanModeState>(PLAN_STATE_ENTRY, state);
	}

	/** Enter plan mode: capture the active tools and narrow to read-only. */
	function enter(ctx: ExtensionContext): void {
		const prePlan = pi.getActiveTools();
		enterPlan(prePlan);
		setAgentMutationPaused(true);
		pi.setActiveTools(computeReadOnlyTools(prePlan));
		persist();
		updateStatus(ctx);
	}

	/** Exit plan mode: restore the pre-plan tool set (sanitized) and clear state. */
	function exit(ctx: ExtensionContext): void {
		const { prePlanActiveTools } = getState();
		const available = pi.getAllTools().map((t) => t.name);
		const restored = sanitizeToolNames(prePlanActiveTools, available).filter((n) => n !== EXIT_TOOL_NAME);
		exitPlan();
		if (restored.length > 0) pi.setActiveTools(restored);
		setAgentMutationPaused(false);
		persist();
		updateStatus(ctx);
	}

	/** Toggle between on/off (used by Shift+Tab). */
	function toggle(ctx: ExtensionContext): void {
		if (getState().enabled) exit(ctx);
		else enter(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use `/plan on` / `/plan off`",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const enabled = getState().enabled;
			if (arg === "on") {
				if (!enabled) enter(ctx);
			} else if (arg === "off") {
				if (enabled) exit(ctx);
			} else {
				toggle(ctx);
			}
			if (ctx.hasUI) {
				ctx.ui.notify(getState().enabled ? "Plan mode on (read-only)." : "Plan mode off.", "info");
			}
		},
	});

	// Toggle plan mode via a configurable shortcut (default alt+p). NOT shift+tab:
	// pi binds shift+tab to the built-in app.thinking.cycle and would drop this
	// shortcut at startup as a conflict. `/plan` is the reliable primary entry.
	const toggleKey = resolveToggleKey(pi);
	pi.registerShortcut(toggleKey, {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (ctx) => toggle(ctx),
	});

	// Tool the model calls to submit its plan and request exit.
	pi.registerTool<typeof ExitPlanParamsSchema>({
		name: EXIT_TOOL_NAME,
		label: "Exit Plan Mode",
		description:
			"Submit the finished plan and request to leave read-only plan mode. Call this only after you have fully explored the code and written a concrete, decision-complete plan. The user reviews and approves before implementation begins.",
		promptSnippet: "Submit your plan and exit read-only plan mode once it is ready for approval.",
		parameters: ExitPlanParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: ExitPlanParams, _signal, _onUpdate, ctx) {
			if (!getState().enabled) {
				return { content: [{ type: "text", text: NOT_IN_PLAN_MESSAGE }], details: undefined };
			}
			// No UI (print/RPC): can't confirm, so allow the exit by default.
			if (!ctx.hasUI) {
				exit(ctx);
				return { content: [{ type: "text", text: EXIT_APPROVED_MESSAGE }], details: undefined };
			}
			const approved = await ctx.ui.confirm(EXIT_CONFIRM_TITLE, exitConfirmBody(params.plan));
			if (approved) {
				exit(ctx);
				return { content: [{ type: "text", text: EXIT_APPROVED_MESSAGE }], details: undefined };
			}
			return { content: [{ type: "text", text: EXIT_REJECTED_MESSAGE }], details: undefined, isError: true };
		},
	});

	// Augment the system prompt with planning instructions while in plan mode.
	pi.on("before_agent_start", async (event) => {
		if (!getState().enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_SYSTEM_PROMPT}` };
	});

	// Read-only guard: block write-class tools and write bash commands.
	pi.on("tool_call", async (event) => {
		if (!getState().enabled) return;
		if (isToolCallEventType("bash", event) || event.toolName === "task_bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string" && isWriteBashCommand(command)) {
				return {
					block: true,
					reason: "Plan 模式只读:该 shell 命令会修改文件或系统状态,已被拦截。请仅用只读命令探查,完成后调用 exit_plan_mode 提交计划。",
				};
			}
			return;
		}
		if (isWriteTool(event.toolName)) {
			return {
				block: true,
				reason: "Plan 模式只读,不能调用写工具或启动可能绕过只读边界的子 Agent。完成探查后调用 exit_plan_mode 提交计划,经用户批准后再实现。",
			};
		}
	});

	// Restore persisted state on session start / tree navigation / compaction.
	function restore(ctx: ExtensionContext): void {
		const startInPlan = pi.getFlag("plan") === true;
		const restored = restoreStateFromBranch(ctx.sessionManager.getBranch());
		if (restored) {
			// Re-sanitize restored pre-plan tools against currently loaded tools.
			const available = pi.getAllTools().map((t) => t.name);
			setState({
				enabled: restored.enabled || startInPlan,
				prePlanActiveTools: sanitizeToolNames(restored.prePlanActiveTools, available),
			});
		} else if (startInPlan) {
			// Fresh session started with --plan: enter plan mode. The block below
			// captures the pre-plan tools and narrows the active set.
			setState({ enabled: true, prePlanActiveTools: [] });
		}

		setAgentMutationPaused(getState().enabled);
		if (getState().enabled) {
			// Only capture pre-plan tools if we didn't already have them persisted.
			if (getState().prePlanActiveTools.length === 0) {
				enterPlan(pi.getActiveTools());
			}
			pi.setActiveTools(computeReadOnlyTools(getState().prePlanActiveTools));
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_compact", async (_event, ctx) => restore(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		// Invalidate any teammate approval before child sessions are suspended.
		setAgentMutationPaused(true);
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
		}
	});
}

/** Read the configured toggle key, falling back to the default when unset/blank. */
function resolveToggleKey(pi: ExtensionAPI): KeyId {
	const raw = pi.getFlag(TOGGLE_KEY_FLAG);
	const key = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_TOGGLE_KEY;
	return key as KeyId;
}
