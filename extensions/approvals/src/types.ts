// Shared types for the approvals extension. Pure type module — no runtime.

/** What a decision resolves to. Precedence: deny > ask > allow. */
export type Effect = "allow" | "ask" | "deny";

/**
 * Permission mode governs the fallback behavior when no explicit rule or
 * safety verdict decides a tool call.
 * - default:     writes + dangerous commands ask; read-only auto-allowed.
 * - acceptEdits: edit/write auto-allowed; dangerous commands still ask.
 * - bypass:      everything allowed EXCEPT protected paths + dangerous/
 *                catastrophic commands, which still prompt/deny ("危险仍提示").
 */
export type PermissionMode = "default" | "acceptEdits" | "bypass";

/**
 * A user-configurable rule. All present fields must match (AND).
 * - tool:       tool-name matcher. Exact, trailing "*" prefix, or mcp
 *               server-level ("mcp__server" matches "mcp__server__*").
 * - bashPrefix: normalized bash command prefix, e.g. "git commit",
 *               "npm run". Trailing "*" allowed ("git *").
 * - path:       glob against resolved write/edit target paths.
 */
export interface Rule {
  effect: Effect;
  tool?: string;
  bashPrefix?: string;
  path?: string;
}

/** Coarse categorization of a tool for mode-default fallback. */
export type ToolCategory = "readOnly" | "edit" | "bash" | "other";

/** Where a decision came from, for reason/reporting. */
export type DecisionSource = "protected" | "rule" | "safety" | "mode";

/** Final decision produced by the gate. */
export interface Decision {
  effect: Effect;
  source: DecisionSource;
  reason: string;
  /** The rule that decided, when source === "rule". */
  rule?: Rule;
  /**
   * Tightest matcher to offer on "Always allow" (ask flow only).
   * bashPrefix for bash, tool/mcp name otherwise.
   */
  suggestedMatcher?: Rule;
}

/** A persisted rule mutation. */
export type RuleOp =
  | { op: "add"; rule: Rule }
  | { op: "remove"; index: number };

/** A persisted mode change. */
export interface ModeOp {
  mode: PermissionMode;
}

/** Resolved filesystem context for path matching (kept impure-free in pure modules). */
export interface PathContext {
  cwd: string;
  home: string;
  /** Protected-path glob patterns; falls back to defaults when omitted. */
  protectedPatterns?: string[];
}
