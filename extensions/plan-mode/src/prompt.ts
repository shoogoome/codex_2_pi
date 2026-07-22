/**
 * System-prompt text and user-facing status/result strings for plan mode.
 * Plain constants + tiny formatters, no pi API — trivially testable.
 */

/** Appended to the base system prompt while plan mode is active. */
export const PLAN_SYSTEM_PROMPT = [
	"# Plan Mode (read-only)",
	"",
	"You are currently in PLAN MODE. Your job is to investigate and design a",
	"solution — you must NOT change anything yet.",
	"",
	"Rules while in plan mode:",
	"- You may ONLY explore: read files, search (grep/find/ls/glob), and run",
	"  read-only bash commands (e.g. cat, git status, git diff, ls).",
	"- You MUST NOT modify files or system state. Write/edit/apply_patch are",
	"  disabled, and bash commands that mutate anything (rm, mv, mkdir, touch,",
	"  redirects, git commit, package installs, sed -i, editors, sudo, ...) are",
	"  blocked. Do not try to work around this.",
	"- Do not ask the user to run write commands for you.",
	"",
	"Produce a concrete, decision-complete plan: which files change, what the",
	"changes are, the order of steps, and any risks or open questions resolved",
	"during exploration.",
	"",
	`When the plan is ready, call the ${"`exit_plan_mode`"} tool with the full plan`,
	"as its `plan` argument. The user will review and approve it before any",
	"implementation begins. Do not begin implementing until the plan is approved.",
].join("\n");

/** Short footer status label shown while plan mode is on. */
export const PLAN_STATUS_TEXT = "⏸ plan mode on";

/** Footer status text, or undefined to clear it. */
export function planStatusLabel(enabled: boolean): string | undefined {
	return enabled ? PLAN_STATUS_TEXT : undefined;
}

/** Tool-result text returned to the model when the plan is approved. */
export const EXIT_APPROVED_MESSAGE =
	"Plan approved by the user. Plan mode is now off and write tools are restored — begin implementing the plan.";

/** Tool-result text returned to the model when the user rejects the plan. */
export const EXIT_REJECTED_MESSAGE =
	"The user did not approve the plan. You are still in plan mode (read-only). Refine the plan based on any feedback and call exit_plan_mode again when ready.";

/** Tool-result text when exit_plan_mode is called while not in plan mode. */
export const NOT_IN_PLAN_MESSAGE = "Not in plan mode; there is no plan to submit.";

/** Confirm-dialog title shown when the model submits a plan for approval. */
export const EXIT_CONFIRM_TITLE = "Exit plan mode?";

/** Build the confirm-dialog body from the submitted plan text. */
export function exitConfirmBody(plan: string): string {
	const trimmed = (plan ?? "").trim();
	const body = trimmed.length > 0 ? trimmed : "(no plan details were provided)";
	return `The agent has finished planning and wants to start implementing:\n\n${body}\n\nApprove and exit plan mode?`;
}
