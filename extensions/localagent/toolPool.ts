import type { AgentDefinition } from "./types.js";

const SAFE_DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const NEVER_INCLUDE = ["task_agent"] as const;

/**
 * Build the tool whitelist for a sub-AgentSession.
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
  const never = new Set<string>(NEVER_INCLUDE);
  tools = tools.filter((t) => !never.has(t));
  return tools;
}
