import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type AgentModel = NonNullable<ExtensionContext["model"]>;
export type AgentThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export interface InheritedAgentRuntime {
  model: AgentModel;
  thinkingLevel: AgentThinkingLevel;
}

/**
 * Clone the live parent turn configuration for a forked LocalAgent.
 *
 * LocalAgent deliberately has no independent model selector: the exact parent
 * model object carries both provider and model identity (plus provider/model
 * compatibility metadata), while thinking follows the current session level.
 */
export function inheritParentRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): InheritedAgentRuntime {
  if (!ctx.model) {
    throw new Error("Cannot fork a LocalAgent because the parent session has no active model.");
  }

  return {
    model: ctx.model,
    thinkingLevel: pi.getThinkingLevel(),
  };
}
