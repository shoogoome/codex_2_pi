import { createHash } from "node:crypto";
import type { AgentDefinition } from "../localagent/types.js";

/**
 * Security-relevant snapshot of a teammate role.
 *
 * Persisting this digest with the teammate identity lets resume fail closed
 * when a project/user role file is removed or its prompt/tool policy changes.
 */
export function fingerprintAgentDefinition(agent: AgentDefinition): string {
  const canonical = JSON.stringify({
    agentType: agent.agentType,
    whenToUse: agent.whenToUse,
    tools: agent.tools ?? null,
    disallowedTools: agent.disallowedTools ?? null,
    model: agent.model ?? null,
    background: agent.background ?? null,
    maxTurns: agent.maxTurns ?? null,
    description: agent.description ?? null,
    source: agent.source,
    systemPrompt: agent.systemPrompt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
