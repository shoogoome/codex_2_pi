// Pure matcher logic: decide which command hooks fire for a given event, based
// on the matcher pattern, tool-name aliasing, and an optional `if` permission
// rule pre-filter. Mirrors Claude's matchesPattern semantics closely enough for
// the MVP without importing Claude's Tool/permission internals.

import type { CommandHook, Hook, HookMatcher, HooksConfig, HookEventName } from "./types.js";

/**
 * Map between pi's lowercase built-in tool names and Claude's capitalized
 * names, so a matcher written as "Bash" also matches pi's "bash" tool and vice
 * versa. Custom / MCP tool names pass through unchanged.
 */
const ALIAS_TO_CANONICAL: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Find",
  ls: "Ls",
  glob: "Glob",
};

/** Normalize a tool name to its canonical (capitalized) form when known. */
export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  return ALIAS_TO_CANONICAL[lower] ?? name;
}

/** True when `a` and `b` refer to the same tool under alias normalization. */
function sameTool(a: string, b: string): boolean {
  return normalizeToolName(a) === normalizeToolName(b);
}

/**
 * Decide whether `query` (a tool name, or an event tag for non-tool events)
 * matches `matcher`.
 * - undefined / "" / "*" → matches everything.
 * - simple names or pipe-joined names (/^[A-Za-z0-9_|]+$/) → exact match on any
 *   segment, alias-aware.
 * - anything else → treated as a regular expression (invalid regex → no match).
 */
export function matchesPattern(query: string, matcher: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;

  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    const parts = matcher.split("|").filter((p) => p.length > 0);
    return parts.some((p) => sameTool(p, query));
  }

  try {
    return new RegExp(matcher).test(query);
  } catch {
    return false;
  }
}

export interface IfCondition {
  toolName: string;
  ruleContent: string;
}

/**
 * Parse a permission-rule `if` string like `Bash(git *)` into its tool name and
 * inner rule content. Returns null when the string has no parenthesized body
 * (a bare tool name with no content is treated as "tool-name only").
 */
export function parseIfCondition(ifStr: string): IfCondition | null {
  const trimmed = ifStr.trim();
  const open = trimmed.indexOf("(");
  if (open === -1 || !trimmed.endsWith(")")) {
    // Bare tool name, e.g. "Bash" — no inner content.
    if (trimmed.length > 0) return { toolName: trimmed, ruleContent: "" };
    return null;
  }
  const toolName = trimmed.slice(0, open).trim();
  const ruleContent = trimmed.slice(open + 1, -1).trim();
  return { toolName, ruleContent };
}

/**
 * Convert a glob-ish rule content ("git *", "git commit*") into a prefix by
 * cutting at the first `*`. "git *" → "git " prefix; "npm" → "npm" prefix.
 */
function rulePrefix(ruleContent: string): string {
  const star = ruleContent.indexOf("*");
  return star === -1 ? ruleContent : ruleContent.slice(0, star);
}

/**
 * Evaluate an `if` permission-rule condition against a concrete tool call.
 * MVP semantics:
 * - The rule's tool name must match the event's tool (alias-aware). Mismatch →
 *   the hook is filtered out (returns false).
 * - For bash, the command must start with the rule's prefix (glob before `*`).
 * - For other tools with a rule body, we do a best-effort prefix match against
 *   a representative string field (path / file_path / pattern); when we can't
 *   find one, we conservatively allow (return true) so the hook still runs.
 * - Empty rule content (bare tool name) → matches any call to that tool.
 * Non-tool events (empty toolName arg) ignore `if` entirely (returns true).
 */
export function evaluateIf(
  ifStr: string | undefined,
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (ifStr === undefined || ifStr.trim() === "") return true;
  // Non-tool events carry no tool name; `if` is a tool-scoped concept, skip it.
  if (toolName === "") return true;

  const cond = parseIfCondition(ifStr);
  if (!cond) return true;
  if (!sameTool(cond.toolName, toolName)) return false;
  if (cond.ruleContent === "") return true;

  const prefix = rulePrefix(cond.ruleContent);
  if (prefix === "") return true;

  const canonical = normalizeToolName(toolName);
  if (canonical === "Bash") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    return cmd.startsWith(prefix);
  }

  // Best-effort field pick for non-bash tools.
  const candidate =
    (typeof input?.path === "string" && input.path) ||
    (typeof input?.file_path === "string" && input.file_path) ||
    (typeof input?.pattern === "string" && input.pattern) ||
    "";
  if (candidate === "") return true;
  return candidate.startsWith(prefix);
}

/** Type guard for the only executor we run in the MVP. */
export function isCommandHook(hook: Hook): hook is CommandHook {
  return hook.type === "command";
}

/**
 * Collect every hook (all types) that should fire for an event, applying the
 * matcher pattern and the optional `if` pre-filter. `matchQuery` is the tool
 * name for tool events, or "" for non-tool events (SessionStart, Stop, …) where
 * a matcher of "*"/absent matches. `toolInput` powers the `if` bash-prefix
 * check and is undefined for non-tool events.
 */
export function getMatchingHooks(
  config: HooksConfig,
  eventName: HookEventName,
  matchQuery: string,
  toolInput: Record<string, unknown> | undefined,
): Hook[] {
  const matchers: HookMatcher[] = config[eventName] ?? [];
  const result: Hook[] = [];
  for (const m of matchers) {
    if (!matchesPattern(matchQuery, m.matcher)) continue;
    // A matcher-level `if` gates the whole block.
    if (!evaluateIf(m.if, matchQuery, toolInput)) continue;
    for (const hook of m.hooks) {
      // A hook-level `if` gates the individual hook.
      if (!evaluateIf(hook.if, matchQuery, toolInput)) continue;
      result.push(hook);
    }
  }
  return result;
}

/** Same as getMatchingHooks but narrowed to command hooks (the MVP executor). */
export function getMatchingCommandHooks(
  config: HooksConfig,
  eventName: HookEventName,
  matchQuery: string,
  toolInput: Record<string, unknown> | undefined,
): CommandHook[] {
  return getMatchingHooks(config, eventName, matchQuery, toolInput).filter(isCommandHook);
}
