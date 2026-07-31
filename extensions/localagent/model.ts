import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.js";

export type AgentModelAlias = Exclude<AgentDefinition["model"], "inherit" | undefined>;
export type AgentModel = NonNullable<ExtensionContext["model"]>;
export type AgentThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export interface ResolvedAgentRuntime {
  model: AgentModel;
  thinkingLevel: AgentThinkingLevel;
}

function modelText(model: AgentModel): string {
  return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
}

function aliasPriority(model: AgentModel, alias: AgentModelAlias): number {
  const text = modelText(model);
  if (!text.includes(alias)) return Number.POSITIVE_INFINITY;
  if (model.provider === "anthropic") return 0;
  if (model.provider === "amazon-bedrock") return 1;
  if (model.provider === "github-copilot") return 2;
  return 10;
}

/**
 * Resolve the child model from the live parent session, never from a second
 * SettingsManager snapshot. This mirrors Codex's turn-config cloning and
 * Claude's getAgentModel precedence:
 *
 * explicit tool parameter > agent frontmatter > inherit current parent.
 */
export function resolveAgentRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestedModel: AgentModelAlias | undefined,
  definitionModel: AgentDefinition["model"],
): ResolvedAgentRuntime {
  const selection = requestedModel ?? definitionModel;
  let model: AgentModel | undefined;

  if (selection === undefined || selection === "inherit") {
    model = ctx.model;
  } else {
    model = [...ctx.modelRegistry.getAvailable()]
      .filter((candidate) => Number.isFinite(aliasPriority(candidate, selection)))
      .sort((a, b) => aliasPriority(a, selection) - aliasPriority(b, selection))[0];
    if (!model) {
      throw new Error(
        `No authenticated model matches alias "${selection}". Omit model to inherit ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the parent model"}.`,
      );
    }
  }

  if (!model) {
    throw new Error("Cannot spawn an agent because the parent session has no active model.");
  }

  return {
    model,
    thinkingLevel: pi.getThinkingLevel(),
  };
}
