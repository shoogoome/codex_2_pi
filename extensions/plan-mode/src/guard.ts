/**
 * Pure helpers for plan mode's read-only guard.
 *
 * - Classify write-class tools (write/edit/apply_patch).
 * - Compute the read-only active tool set from the pre-plan set.
 * - Classify bash commands as write operations (denylist semantics).
 *
 * Kept free of any pi API so it can be unit tested in isolation.
 */

/**
 * Tools that are always blocked in plan mode.
 *
 * `task_agent` is included even though it does not write by itself: allowing a
 * plan-mode root to spawn a general-purpose child would bypass the root's
 * read-only tool set and make the safety boundary prompt-only.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"apply_patch",
	"task_agent",
]);

/** Name of the tool the model calls to submit its plan and leave plan mode. */
export const EXIT_TOOL_NAME = "exit_plan_mode";

/** True if `name` is mutating or can bypass the read-only boundary. */
export function isWriteTool(name: string): boolean {
	return WRITE_TOOL_NAMES.has(name);
}

/**
 * Compute the read-only active tool set for plan mode.
 *
 * Starts from the pre-plan active tools, drops write-class tools, de-dupes,
 * and ensures the exit tool is present. `bash` (if it was active) is kept —
 * write bash commands are intercepted at runtime by {@link isWriteBashCommand}.
 */
export function computeReadOnlyTools(prePlanActiveTools: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of prePlanActiveTools) {
		if (isWriteTool(name)) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	if (!seen.has(EXIT_TOOL_NAME)) {
		result.push(EXIT_TOOL_NAME);
	}
	return result;
}

/**
 * Keep only tool names that actually exist in the current registry.
 *
 * Used when restoring `prePlanActiveTools` from a persisted session, where the
 * set of loaded tools may differ from when the state was saved.
 */
export function sanitizeToolNames(names: readonly string[], available: readonly string[]): string[] {
	const allowed = new Set(available);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (!allowed.has(name)) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

/**
 * Denylist of destructive / mutating bash operations. Anything matching one of
 * these is treated as a write operation and blocked while in plan mode.
 */
const WRITE_BASH_PATTERNS: readonly RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	// Output redirection: `>` (not `>>` here) and `>>`.
	/(^|[^<>])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\d?\s+(install|uninstall)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|am|apply)\b/i,
	/\bsed\s+(-[a-z]*i|--in-place)\b/i,
	/\b(vim?|nano|emacs|code|subl|pico)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
];

/**
 * True if the bash `command` matches a known write/mutating operation and must
 * be blocked in plan mode. Read-only commands (cat, grep, ls, git status, ...)
 * return false.
 */
export function isWriteBashCommand(command: string): boolean {
	if (typeof command !== "string" || command.trim() === "") return false;
	return WRITE_BASH_PATTERNS.some((pattern) => pattern.test(command));
}
