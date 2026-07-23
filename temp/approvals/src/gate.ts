// Pure orchestration: combine protected-paths + rule engine + command safety +
// permission-mode fallback into a single Decision. index.ts only wires this.

import { classifyCommand, extractWriteTargets } from "./commandSafety.js";
import { checkTargets, resolvePath } from "./protectedPaths.js";
import { decide } from "./rules.js";
import type { Decision, Effect, PermissionMode, PathContext, Rule, ToolCategory } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multi_edit"]);

/** Coarse category used for the mode-default fallback. */
export function category(toolName: string): ToolCategory {
  if (READ_ONLY_TOOLS.has(toolName)) return "readOnly";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (toolName === "bash") return "bash";
  return "other";
}

function getString(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Raw (unresolved) candidate write/edit paths for a tool call. */
function rawPaths(toolName: string, input: unknown): string[] {
  const cat = category(toolName);
  if (cat === "edit") {
    const p = getString(input, "path") ?? getString(input, "file_path");
    return p ? [p] : [];
  }
  if (cat === "bash") {
    const cmd = getString(input, "command");
    return cmd ? extractWriteTargets(cmd) : [];
  }
  return [];
}

/** Mode-default effect when nothing else decided. */
function modeDefault(cat: ToolCategory, mode: PermissionMode): { effect: Effect; reason: string } {
  if (cat === "readOnly") return { effect: "allow", reason: "read-only tool" };
  if (mode === "bypass") return { effect: "allow", reason: "bypass mode" };
  if (cat === "edit") {
    return mode === "acceptEdits"
      ? { effect: "allow", reason: "acceptEdits mode auto-approves edits" }
      : { effect: "ask", reason: "write operation" };
  }
  // other / bash fallback
  return { effect: "ask", reason: "requires approval by default" };
}

/**
 * Evaluate a tool call into a Decision. Precedence (highest first):
 *   protected-path deny
 *   > deny rule
 *   > catastrophic command
 *   > allow rule
 *   > dangerous command (ask)
 *   > ask rule
 *   > read-only command (allow)
 *   > mode default
 */
export function evaluate(
  toolName: string,
  input: unknown,
  rules: Rule[],
  mode: PermissionMode,
  ctx: PathContext,
): Decision {
  const cat = category(toolName);
  const raw = rawPaths(toolName, input);
  const resolved = raw.map((p) => resolvePath(p, ctx));

  // Stage 1 — protected paths (unconditional deny in every mode).
  const prot = checkTargets(raw, ctx);
  if (prot.protected) {
    return {
      effect: "deny",
      source: "protected",
      reason: `Protected path (${prot.pattern}): ${prot.matched}`,
    };
  }

  // Stage 3 pre-compute — command safety for bash.
  const isBash = cat === "bash";
  const cmd = isBash ? getString(input, "command") : undefined;
  const safety = isBash && cmd !== undefined ? classifyCommand(cmd) : undefined;
  const bashPrefixes = safety ? safety.prefixes : undefined;

  // Stage 2 — rule engine.
  const ruleDecision = decide(rules, { toolName, bashPrefixes, paths: resolved });

  const suggested = suggestedMatcher(toolName, cat, safety?.worst.prefix);

  // deny rule
  if (ruleDecision?.effect === "deny") {
    return {
      effect: "deny",
      source: "rule",
      reason: `Denied by rule: ${describeRule(ruleDecision.rule)}`,
      rule: ruleDecision.rule,
    };
  }
  // catastrophic command
  if (safety?.effect === "deny") {
    return { effect: "deny", source: "safety", reason: `Dangerous command: ${safety.reason}` };
  }
  // allow rule (overrides ask floors, not deny)
  if (ruleDecision?.effect === "allow") {
    return {
      effect: "allow",
      source: "rule",
      reason: `Allowed by rule: ${describeRule(ruleDecision.rule)}`,
      rule: ruleDecision.rule,
    };
  }
  // dangerous command → ask (even in bypass)
  if (safety?.effect === "ask") {
    return {
      effect: "ask",
      source: "safety",
      reason: `Command needs approval: ${safety.reason}`,
      suggestedMatcher: suggested,
    };
  }
  // ask rule
  if (ruleDecision?.effect === "ask") {
    return {
      effect: "ask",
      source: "rule",
      reason: `Ask by rule: ${describeRule(ruleDecision.rule)}`,
      rule: ruleDecision.rule,
      suggestedMatcher: suggested,
    };
  }
  // read-only command → allow
  if (safety?.effect === "allow") {
    return { effect: "allow", source: "safety", reason: safety.reason };
  }

  // Stage 4 — mode default.
  const md = modeDefault(cat, mode);
  return {
    effect: md.effect,
    source: "mode",
    reason: md.reason,
    suggestedMatcher: md.effect === "ask" ? suggested : undefined,
  };
}

/** Tightest allow matcher to offer on the "Always allow" prompt. */
export function suggestedMatcher(
  toolName: string,
  cat: ToolCategory,
  bashPrefix: string | undefined,
): Rule | undefined {
  if (cat === "bash") {
    if (bashPrefix && bashPrefix.length > 0) return { effect: "allow", bashPrefix };
    return { effect: "allow", tool: "bash" };
  }
  return { effect: "allow", tool: toolName };
}

function describeRule(rule: Rule): string {
  const parts: string[] = [];
  if (rule.tool) parts.push(`tool=${rule.tool}`);
  if (rule.bashPrefix) parts.push(`bash="${rule.bashPrefix}"`);
  if (rule.path) parts.push(`path=${rule.path}`);
  return parts.join(" ") || "(empty)";
}
