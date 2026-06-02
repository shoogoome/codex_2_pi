import type { AgentDefinition } from "../types.js";

/**
 * Merge agent definitions. Priority: project > user > built-in.
 * For each agentType the highest-priority definition wins entirely
 * (no field-level merge).
 */
export function mergeAgentDefinitions(
  builtIn: AgentDefinition[],
  user: AgentDefinition[],
  project: AgentDefinition[],
): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const d of builtIn) map.set(d.agentType, d);
  for (const d of user) map.set(d.agentType, d);
  for (const d of project) map.set(d.agentType, d);
  return Array.from(map.values());
}

export function getAgentDefinition(
  defs: AgentDefinition[],
  agentType: string,
): AgentDefinition | undefined {
  return defs.find((d) => d.agentType === agentType);
}
