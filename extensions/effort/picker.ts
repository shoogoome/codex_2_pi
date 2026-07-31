import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type EffortLevel,
  type ReasoningModelRef,
  defaultEffortForModel,
  effortLabel,
  isAdvancedEffort,
  reasoningOptionsForModel,
} from "./reasoning.js";

export const MORE_REASONING_LABEL = "More reasoning…";
export const ALL_PROVIDERS_LABEL = "All providers… — Browse every available Pi provider";

type PiModel = NonNullable<ExtensionContext["model"]>;

export interface ModelEffortSelection {
  model: PiModel;
  effort: EffortLevel;
}

function markedLabel(label: string, current: boolean): string {
  return current ? `● ${label} (current)` : label;
}

/** Codex-style two-stage effort picker: standard scale, then explicit Max/Ultra. */
export async function selectReasoningEffort(
  ctx: ExtensionContext,
  model: PiModel,
  current: EffortLevel | undefined,
  ultraCapable = false,
): Promise<EffortLevel | undefined> {
  const options = reasoningOptionsForModel(model as ReasoningModelRef, ultraCapable);
  if (options.length === 0) return undefined;

  const standard = options.filter((option) => !option.advanced);
  const advanced = options.filter((option) => option.advanced);
  if (standard.length === 1 && advanced.length === 0) return standard[0].level;

  const defaultLevel = defaultEffortForModel(options, undefined);
  const labelToLevel = new Map<string, EffortLevel>();
  const items: string[] = [];
  for (const option of standard) {
    const defaultSuffix = option.level === defaultLevel ? " (default)" : "";
    const base = `${option.label}${defaultSuffix} — ${option.description}`;
    const label = markedLabel(base, current === option.level);
    labelToLevel.set(label, option.level);
    items.push(label);
  }

  if (advanced.length > 0) {
    const names = advanced.map((option) => option.label).join(" and ");
    const verb = advanced.length === 1 ? "consumes" : "consume";
    const base = `${MORE_REASONING_LABEL} — ${names} ${verb} usage limits faster`;
    const label = markedLabel(base, current !== undefined && isAdvancedEffort(current));
    labelToLevel.set(label, "max"); // sentinel; the label itself is checked below.
    items.push(label);
  }

  const selected = await ctx.ui.select(`Select Reasoning Level for ${model.id}`, items);
  if (!selected) return undefined;
  if (!selected.includes(MORE_REASONING_LABEL)) return labelToLevel.get(selected);

  const advancedMap = new Map<string, EffortLevel>();
  const advancedItems = advanced.map((option) => {
    const label = markedLabel(
      `${option.label} — ${option.description}`,
      current === option.level,
    );
    advancedMap.set(label, option.level);
    return label;
  });
  const advancedSelected = await ctx.ui.select(
    "Advanced Reasoning · ⚠ Consumes usage limits faster",
    advancedItems,
  );
  return advancedSelected ? advancedMap.get(advancedSelected) : undefined;
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function sameModel(a: PiModel | undefined, b: PiModel | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function modelOptionLabel(model: PiModel, current: PiModel | undefined): string {
  const displayName = model.name && model.name !== model.id ? ` — ${model.name}` : "";
  return markedLabel(`${modelKey(model)}${displayName}`, sameModel(model, current));
}

function modelPriority(model: PiModel): number {
  if (model.provider !== "openai-codex") return 100;
  switch (model.id.toLowerCase()) {
    case "gpt-5.6-sol":
      return 0;
    case "gpt-5.6-terra":
      return 1;
    case "gpt-5.6-luna":
      return 2;
    default:
      return 50;
  }
}

function sortModels(models: readonly PiModel[]): PiModel[] {
  return [...models].sort((a, b) => {
    const priority = modelPriority(a) - modelPriority(b);
    return priority || modelKey(a).localeCompare(modelKey(b));
  });
}

async function selectFromModels(
  ctx: ExtensionContext,
  models: readonly PiModel[],
  title: string,
): Promise<PiModel | undefined> {
  const labelToModel = new Map<string, PiModel>();
  const labels = sortModels(models).map((model) => {
    const label = modelOptionLabel(model, ctx.model);
    labelToModel.set(label, model);
    return label;
  });
  const selected = await ctx.ui.select(title, labels);
  return selected ? labelToModel.get(selected) : undefined;
}

async function selectProviderModel(
  ctx: ExtensionContext,
  models: readonly PiModel[],
): Promise<PiModel | undefined> {
  const grouped = new Map<string, PiModel[]>();
  for (const model of models) {
    const bucket = grouped.get(model.provider) ?? [];
    bucket.push(model);
    grouped.set(model.provider, bucket);
  }
  const providerMap = new Map<string, string>();
  const providerLabels = [...grouped.entries()]
    .sort(([a], [b]) => {
      if (a === ctx.model?.provider) return -1;
      if (b === ctx.model?.provider) return 1;
      return a.localeCompare(b);
    })
    .map(([provider, providerModels]) => {
      const suffix = provider === ctx.model?.provider ? " (current provider)" : "";
      const label = `${provider}${suffix} — ${providerModels.length} models`;
      providerMap.set(label, provider);
      return label;
    });
  const selectedProvider = await ctx.ui.select("Select Model Provider", providerLabels);
  if (!selectedProvider) return undefined;
  const provider = providerMap.get(selectedProvider);
  return provider
    ? selectFromModels(ctx, grouped.get(provider) ?? [], `Select Model · ${provider}`)
    : undefined;
}

/**
 * Pi-host adaptation of Codex's /model → model → reasoning flow. The current
 * provider is shown first; "All providers…" keeps Pi's multi-provider escape
 * hatch without losing the atomic model+effort selection.
 */
export async function selectModelAndEffort(
  ctx: ExtensionContext,
  searchTerm: string | undefined,
  currentEffort: EffortLevel | undefined,
  isUltraCapable: (model: PiModel) => boolean,
): Promise<ModelEffortSelection | undefined> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    ctx.ui.notify("No authenticated models are available.", "warning");
    return undefined;
  }

  let selectedModel: PiModel | undefined;
  const term = searchTerm?.trim().toLowerCase();
  if (term) {
    const matches = available.filter((model) => {
      const haystack = `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
      return haystack.includes(term);
    });
    if (matches.length === 0) {
      ctx.ui.notify(`No model matches "${searchTerm}".`, "warning");
      return undefined;
    }
    selectedModel = await selectFromModels(ctx, matches, `Select Model · ${searchTerm}`);
  } else {
    const currentProvider = ctx.model?.provider;
    const currentProviderModels = currentProvider
      ? available.filter((model) => model.provider === currentProvider)
      : [];
    if (currentProviderModels.length > 0) {
      const labelToModel = new Map<string, PiModel>();
      const items = sortModels(currentProviderModels).map((model) => {
        const label = modelOptionLabel(model, ctx.model);
        labelToModel.set(label, model);
        return label;
      });
      if (available.some((model) => model.provider !== currentProvider)) items.push(ALL_PROVIDERS_LABEL);
      const selected = await ctx.ui.select("Select Model", items);
      if (!selected) return undefined;
      selectedModel = selected === ALL_PROVIDERS_LABEL
        ? await selectProviderModel(ctx, available)
        : labelToModel.get(selected);
    } else {
      selectedModel = await selectProviderModel(ctx, available);
    }
  }
  if (!selectedModel) return undefined;

  const ultraCapable = isUltraCapable(selectedModel);
  const options = reasoningOptionsForModel(
    selectedModel as ReasoningModelRef,
    ultraCapable,
  );
  const preferred = sameModel(selectedModel, ctx.model) ? currentEffort : undefined;
  const current = defaultEffortForModel(options, preferred);
  const effort = await selectReasoningEffort(ctx, selectedModel, current, ultraCapable);
  return effort ? { model: selectedModel, effort } : undefined;
}
