// Pure rule engine: tool-name / bash-prefix / path matching + worst-of
// precedence (deny > ask > allow), matcher parsing and formatting.

import { globToRegExp } from "./protectedPaths.js";
import type { Effect, Rule } from "./types.js";

const EFFECT_RANK: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Match a tool-name pattern against a concrete tool name.
 * - Exact match.
 * - Trailing "*": prefix match ("mcp__github__*", "task_*").
 * - MCP server-level: "mcp__server" matches "mcp__server__<tool>".
 */
export function matchToolName(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern === name) return true;
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  // Server-level MCP: pattern "mcp__server" (no third segment) matches any tool
  // exported by that server.
  if (pattern.startsWith("mcp__") && !pattern.slice(5).includes("__")) {
    return name === pattern || name.startsWith(pattern + "__");
  }
  return false;
}

/** Match a rule's bashPrefix against the set of a command's segment prefixes. */
export function matchBashPrefix(rulePrefix: string, segmentPrefixes: string[]): boolean {
  const isWild = rulePrefix.endsWith("*");
  const base = isWild ? rulePrefix.slice(0, -1).trimEnd() : rulePrefix;
  return segmentPrefixes.some((seg) => {
    if (rulePrefix === "*") return true;
    if (!isWild) return seg === rulePrefix;
    // "git *" matches "git commit"; also matches bare "git".
    return seg === base || seg.startsWith(base + " ") || seg.startsWith(base);
  });
}

export interface MatchInput {
  toolName: string;
  /** Present for bash calls: normalized prefixes across all segments. */
  bashPrefixes?: string[];
  /** Present for write/edit/bash: resolved candidate paths. */
  paths?: string[];
}

/** Does a rule match a tool call? All present fields must match (AND). */
export function ruleMatches(rule: Rule, input: MatchInput): boolean {
  if (rule.tool !== undefined && !matchToolName(rule.tool, input.toolName)) {
    return false;
  }
  if (rule.bashPrefix !== undefined) {
    const prefixes = input.bashPrefixes ?? [];
    if (!matchBashPrefix(rule.bashPrefix, prefixes)) return false;
  }
  if (rule.path !== undefined) {
    const paths = input.paths ?? [];
    const re = globToRegExp(rule.path);
    if (!paths.some((p) => re.test(p))) return false;
  }
  // A rule with no fields at all matches nothing (avoid accidental catch-all).
  if (rule.tool === undefined && rule.bashPrefix === undefined && rule.path === undefined) {
    return false;
  }
  return true;
}

export interface RuleDecision {
  rule: Rule;
  effect: Effect;
}

/**
 * Pick the worst-effect matching rule (deny > ask > allow). Returns null when
 * no rule matches. Ties break toward the earliest rule.
 */
export function decide(rules: Rule[], input: MatchInput): RuleDecision | null {
  let best: RuleDecision | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, input)) continue;
    if (best === null || EFFECT_RANK[rule.effect] > EFFECT_RANK[best.effect]) {
      best = { rule, effect: rule.effect };
    }
  }
  return best;
}

/**
 * Parse a matcher string into a Rule body (without effect). Forms:
 * - "bash:git commit"  → { bashPrefix: "git commit" }
 * - "path:src/**"      → { path: "src/**" }
 * - "mcp__github"      → { tool: "mcp__github" }
 * - bare name          → { tool: name }
 */
export function parseMatcher(str: string): Omit<Rule, "effect"> {
  const trimmed = str.trim();
  if (trimmed.startsWith("bash:")) {
    return { bashPrefix: trimmed.slice("bash:".length).trim() };
  }
  if (trimmed.startsWith("path:")) {
    return { path: trimmed.slice("path:".length).trim() };
  }
  if (trimmed.startsWith("tool:")) {
    return { tool: trimmed.slice("tool:".length).trim() };
  }
  return { tool: trimmed };
}

/** Render a rule as a stable, human-readable one-liner. */
export function formatRule(rule: Rule): string {
  const parts: string[] = [];
  if (rule.tool !== undefined) parts.push(`tool=${rule.tool}`);
  if (rule.bashPrefix !== undefined) parts.push(`bash="${rule.bashPrefix}"`);
  if (rule.path !== undefined) parts.push(`path=${rule.path}`);
  return `${rule.effect} ${parts.join(" ") || "(empty)"}`;
}
