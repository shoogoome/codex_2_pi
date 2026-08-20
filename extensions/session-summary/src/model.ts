import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SummaryModel = Model<any>;

export function modelRef(model: SummaryModel): string {
  return `${model.provider}/${model.id}`;
}

function modelText(model: SummaryModel): string {
  return `${modelRef(model)} ${model.name ?? ""}`.toLowerCase();
}

export function findSummaryModelMatches(
  models: readonly SummaryModel[],
  query: string,
): SummaryModel[] {
  const term = query.trim().toLowerCase();
  if (!term || term === "inherit" || term === "current") return [];

  const exactRef = models.filter((model) => modelRef(model).toLowerCase() === term);
  if (exactRef.length > 0) return exactRef;
  const exactId = models.filter((model) => model.id.toLowerCase() === term);
  if (exactId.length > 0) return exactId;
  return models.filter((model) => modelText(model).includes(term));
}

export function resolveSummaryModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  configuredRef?: string,
): SummaryModel {
  const normalizedRef = configuredRef?.trim();
  const lowerRef = normalizedRef?.toLowerCase();
  if (!normalizedRef || lowerRef === "inherit" || lowerRef === "current") {
    if (!ctx.model) throw new Error("当前会话没有可用主模型");
    return ctx.model;
  }

  const matches = findSummaryModelMatches(ctx.modelRegistry.getAvailable(), normalizedRef);
  if (matches.length === 0) throw new Error(`找不到摘要模型 ${normalizedRef}`);
  if (matches.length > 1) {
    throw new Error(`摘要模型 ${normalizedRef} 匹配到多个模型，请使用 provider/model 精确指定`);
  }
  return matches[0];
}

export function summaryModelLabel(ctx: Pick<ExtensionContext, "model">, configuredRef?: string): string {
  if (configuredRef) return configuredRef;
  return ctx.model ? `随主模型 ${modelRef(ctx.model)}` : "随主模型";
}
