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
 *
 * Redirection is deliberately NOT in this list. It needs target inspection
 * (see {@link hasFileWriteRedirect}) because `2>&1` and `2>/dev/null` are
 * extremely common on read-only commands and write nothing.
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
	if (hasFileWriteRedirect(command)) return true;
	return WRITE_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Redirection targets that write NOTHING to a file: file descriptors and the
 * null/device sinks. `2>&1` (merge stderr into stdout), `1>/dev/null`,
 * `&>/dev/null`, `2>&-` (close fd) all fall in here.
 */
function isNonFileTarget(after: string): boolean {
	const t = after.trim();
	if (t.startsWith("&")) return true; // &1, &2, &- (fd dup/close)
	if (t.startsWith("/dev/")) return true; // /dev/null, /dev/stderr, /dev/fd/N
	return false;
}

/**
 * Strip single-quoted spans, double-quoted spans, heredoc bodies, and comment
 * tails before scanning for redirects.
 *
 * Why: `grep -c ">" file`, `echo "a > b"`, and `python3 -c "open('x','w')..."`
 * contain `>` as DATA, not as a redirect operator. The old logic scanned raw
 * text and flagged all of them.
 *
 * Deliberately conservative: a construct we fail to strip can still produce a
 * false positive (over-blocking), which is the safe direction for a guard.
 * Under-stripping never silently allows a write.
 */
function stripInertSpans(command: string): string {
	let out = "";
	let i = 0;
	const heredocs: string[] = [];
	while (i < command.length) {
		const ch = command[i]!;
		// Single quotes: literal, no escapes inside.
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			i = end === -1 ? command.length : end + 1;
			out += "''";
			continue;
		}
		// Double quotes: no redirect operator meaning inside.
		if (ch === '"') {
			let j = i + 1;
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\") j += 1;
				j += 1;
			}
			i = j >= command.length ? command.length : j + 1;
			out += '""';
			continue;
		}
		// Comment to end of line.
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
			const end = command.indexOf("\n", i);
			i = end === -1 ? command.length : end;
			continue;
		}
		// Heredoc: `<<'EOF'` / `<<EOF` — body runs to the delimiter line.
		if (ch === "<" && command[i + 1] === "<") {
			const m = /^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
			if (m) {
				heredocs.push(m[2]!);
				i += m[0].length;
				out += " ";
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	if (heredocs.length === 0) return out;
	// Drop heredoc bodies (they are data, not commands).
	let text = out;
	for (const delim of heredocs) {
		const re = new RegExp(`\\n[^\\n]*${escapeRe(delim)}[^\\n]*\\n?`);
		text = text.replace(re, "\n");
	}
	return text;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if the command redirects stdout/stderr INTO A FILE (a real write).
 *
 * Regression: `ls -la x 2>&1`, `grep -rn X -l . 2>&1`, `sed -n 1,200p f
 * 2>/dev/null` and `python3 -c "print(1)" 2>&1` were all classified as
 * mutating, so a plan-mode / unapproved teammate could not run a single
 * read-only command. `2>&1` merges stderr into stdout; `2>/dev/null` discards
 * it. Neither touches the filesystem.
 *
 * `>>` is always treated as a write: fd duplication uses `>&`, never `>>`, so
 * there is no non-writing reading of `>>`.
 */
export function hasFileWriteRedirect(command: string): boolean {
	const text = stripInertSpans(command);
	// Find every `>` / `>>` operator and decide by its target.
	const re = /(>>?)(?!&)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const op = m[1]!;
		const after = text.slice(m.index + op.length);
		// `>&` / `<&` are fd duplication, not a file target.
		if (after.startsWith("&")) continue;
		if (op === ">>") return true;
		if (!isNonFileTarget(after)) return true;
	}
	return false;
}
