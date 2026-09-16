import type { AgentDefinition } from "./types.js";

const SAFE_DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const NEVER_INCLUDE = new Set(["task_agent"]);

/**
 * A fork inherits the parent's active tool pool, except recursive LocalAgent
 * spawning is always removed.
 */
export function resolveForkTools(allRegistered: readonly string[]): string[] {
  return allRegistered.filter((tool) => !NEVER_INCLUDE.has(tool));
}

/**
 * Build the tool whitelist for a role-based sub-AgentSession (teammates).
 *
 * Rules:
 *   - agentDef.tools missing → safe defaults (read-only)
 *   - agentDef.tools=["*"] → expand to allRegistered
 *   - agentDef.tools=[...] → use as-is
 *   - apply disallowedTools blacklist
 *   - ALWAYS remove "task_agent" (recursion hard-stop)
 */
export function resolveSubAgentTools(
  agentDef: AgentDefinition,
  allRegistered: readonly string[],
): string[] {
  let tools: string[];
  if (!agentDef.tools) {
    tools = [...SAFE_DEFAULT_TOOLS];
  } else if (agentDef.tools.includes("*")) {
    tools = [...allRegistered];
  } else {
    tools = [...agentDef.tools];
  }
  if (agentDef.disallowedTools?.length) {
    const black = new Set(agentDef.disallowedTools);
    tools = tools.filter((t) => !black.has(t));
  }
  return tools.filter((tool) => !NEVER_INCLUDE.has(tool));
}
