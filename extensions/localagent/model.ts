import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.js";

export type AgentModelAlias = Exclude<AgentDefinition["model"], "inherit" | undefined>;
export type AgentModel = NonNullable<ExtensionContext["model"]>;
export type AgentThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export interface InheritedAgentRuntime {
  model: AgentModel;
  thinkingLevel: AgentThinkingLevel;
}

/** @deprecated alias kept for callers of the role-based resolver. */
export type ResolvedAgentRuntime = InheritedAgentRuntime;

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

function modelText(model: AgentModel): string {
  return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
}

/**
 * Rank a candidate for a Claude-style alias (`sonnet` / `opus` / `haiku`).
 * Lower is better; Infinity means "does not match the alias at all".
 *
 * The Anthropic-first ordering only matters when the parent provider cannot
 * supply a match (see `resolveAgentRuntime`) — cross-provider selection is the
 * last resort, not the default.
 */
function aliasPriority(model: AgentModel, alias: AgentModelAlias): number {
  const text = modelText(model);
  if (!text.includes(alias)) return Number.POSITIVE_INFINITY;
  if (model.provider === "anthropic") return 0;
  if (model.provider === "amazon-bedrock") return 1;
  if (model.provider === "github-copilot") return 2;
  return 10;
}

/**
 * Resolve the child runtime for a role-based agent (a teammate).
 *
 * Precedence, mirroring Claude's getAgentModel: explicit request > role
 * definition > inherit the live parent model. The parent model object is read
 * from the live session, never from a second SettingsManager snapshot.
 *
 * The parent's **provider is always authoritative**: a teammate runs on the
 * same provider as the leader, because a team shares one credential/auth
 * context and a cross-provider child would silently bill and behave
 * differently from the session that spawned it. A role (or explicit request)
 * may therefore only pick a *model within the parent provider*. Only when that
 * provider cannot satisfy the alias at all do we fall back to the global
 * ranking, so a role like `model: sonnet` still works when the leader runs a
 * provider with no Claude model.
 */
export function resolveAgentRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestedModel: AgentModelAlias | undefined,
  definitionModel: AgentDefinition["model"],
): InheritedAgentRuntime {
  const selection = requestedModel ?? definitionModel;
  let model: AgentModel | undefined;

  if (selection === undefined || selection === "inherit") {
    model = ctx.model;
  } else {
    const available = [...ctx.modelRegistry.getAvailable()].filter((candidate) =>
      Number.isFinite(aliasPriority(candidate, selection)),
    );
    const parentProvider = ctx.model?.provider;

    // Prefer a match inside the parent provider; never cross providers while
    // one is available. Ties inside the provider keep registration order.
    const inParentProvider = parentProvider
      ? available.filter((candidate) => candidate.provider === parentProvider)
      : [];
    model = (inParentProvider.length > 0 ? inParentProvider : available).sort(
      (a, b) => aliasPriority(a, selection) - aliasPriority(b, selection),
    )[0];

    if (!model) {
      throw new Error(
        `No authenticated model matches alias "${selection}"${parentProvider ? ` on provider "${parentProvider}"` : ""}. Omit model to inherit ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the parent model"}.`,
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
