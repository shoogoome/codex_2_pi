// Pure restore/reducers for session custom entries. Takes plain entry-like
// arrays (data: unknown) so index.ts can pass a filtered getBranch() and tests
// stay independent of pi.

import type { ModeOp, PermissionMode, Rule, RuleOp } from "./types.js";

export const APPROVALS_RULE_ENTRY = "approvals_rule";
export const APPROVALS_MODE_ENTRY = "approvals_mode";

/** Minimal shape we read off a session branch. */
export interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

const EFFECTS = new Set(["allow", "ask", "deny"]);

/** Validate an unknown value into a Rule, or null. */
export function coerceRule(value: unknown): Rule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.effect !== "string" || !EFFECTS.has(v.effect)) return null;
  const rule: Rule = { effect: v.effect as Rule["effect"] };
  if (typeof v.tool === "string") rule.tool = v.tool;
  if (typeof v.bashPrefix === "string") rule.bashPrefix = v.bashPrefix;
  if (typeof v.path === "string") rule.path = v.path;
  if (rule.tool === undefined && rule.bashPrefix === undefined && rule.path === undefined) {
    return null;
  }
  return rule;
}

function coerceRuleOp(data: unknown): RuleOp | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.op === "add") {
    const rule = coerceRule(d.rule);
    return rule ? { op: "add", rule } : null;
  }
  if (d.op === "remove" && typeof d.index === "number") {
    return { op: "remove", index: d.index };
  }
  return null;
}

/**
 * Replay approvals_rule entries in branch order over a defaults baseline.
 * Later entries win; "remove" uses the 1-based index as shown by /approvals.
 */
export function reduceRuleEntries(entries: EntryLike[], defaults: Rule[]): Rule[] {
  const rules = defaults.map((r) => ({ ...r }));
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== APPROVALS_RULE_ENTRY) continue;
    const op = coerceRuleOp(entry.data);
    if (!op) continue;
    if (op.op === "add") {
      rules.push(op.rule);
    } else {
      const idx = op.index - 1;
      if (idx >= 0 && idx < rules.length) rules.splice(idx, 1);
    }
  }
  return rules;
}

const MODES = new Set(["default", "acceptEdits", "bypass"]);

function coerceModeOp(data: unknown): ModeOp | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.mode === "string" && MODES.has(d.mode)) {
    return { mode: d.mode as PermissionMode };
  }
  return null;
}

/** Last approvals_mode entry wins; falls back to the provided default. */
export function extractMode(entries: EntryLike[], fallback: PermissionMode): PermissionMode {
  let mode = fallback;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== APPROVALS_MODE_ENTRY) continue;
    const op = coerceModeOp(entry.data);
    if (op) mode = op.mode;
  }
  return mode;
}
