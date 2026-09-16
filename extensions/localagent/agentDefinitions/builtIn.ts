import type { AgentDefinition } from "../types.js";

export const FORK_AGENT_TYPE = "__fork__" as const;

/** Internal identity for the only LocalAgent execution mode. */
export const FORK_AGENT = {
  agentType: FORK_AGENT_TYPE,
  tools: ["*"],
  source: "built-in",
  systemPrompt: "",
} as const;

/**
 * Built-in role used by long-lived teammates when no role file is selected.
 * `tools:["*"]` is the *role* grant; spawn/hydrate still apply the recursion
 * blocklist, so a general-purpose teammate can never spawn nested teammates.
 */
export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  tools: ["*"],
  source: "built-in",
  systemPrompt:
    "You are a general-purpose research and execution agent dispatched by a parent agent. " +
    "Stay strictly within the assigned task. Use your tools directly; do not converse, " +
    "ask questions, or speculate beyond the task. When done, return a concise factual report.",
};

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "explore",
  whenToUse: "Read-only codebase exploration. Returns excerpts, doesn't modify files.",
  tools: ["read", "grep", "find", "ls"],
  source: "built-in",
  systemPrompt:
    "You are a read-only codebase explorer. You have file-read and search tools only. " +
    "Locate relevant code, return file paths and short excerpts; do not summarize or " +
    "editorialize. Output format: { files: [{path, lineRange, excerpt}], notes: string[] }.",
};

/** LLM 可见的内置 role 列表(不含 FORK_AGENT)。 */
export function getBuiltInAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT];
}
