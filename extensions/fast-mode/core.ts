import type { Model } from "@earendil-works/pi-ai";

export const FAST_MODE_STATE_ENTRY = "fast-mode-state";
export const FAST_SERVICE_TIER = "priority";
export const ULTRAFAST_SERVICE_TIER = "ultrafast";
export type SpeedServiceTier = typeof FAST_SERVICE_TIER | typeof ULTRAFAST_SERVICE_TIER;

export interface FastModeState {
  enabled: boolean;
  /** Missing in legacy entries: ordinary Fast. */
  tier?: SpeedServiceTier;
}

export type FastModel = Pick<Model<any>, "api" | "id" | "provider">;

export type FastAvailability =
  | { active: true }
  | { active: false; reason: "no-model" | "unsupported-model" | "oauth-required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFastCapableModel(model: FastModel | undefined): boolean {
  // The priority service tier applies to every OpenAI Codex Responses model;
  // keep this independent of a hard-coded model ID allowlist.
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function getFastAvailability(
  model: FastModel | undefined,
  usingOAuth: boolean,
  tier: SpeedServiceTier = FAST_SERVICE_TIER,
): FastAvailability {
  if (!model) return { active: false, reason: "no-model" };
  if (!isFastCapableModel(model)) return { active: false, reason: "unsupported-model" };
  if (!usingOAuth) return { active: false, reason: "oauth-required" };
  // Local routing eligibility only; this does not establish account entitlement.
  return { active: true };
}

export function applyFastServiceTier(
  payload: unknown,
  options: {
    enabled: boolean;
    model: FastModel | undefined;
    usingOAuth: boolean;
    tier?: SpeedServiceTier;
  },
): unknown {
  if (!options.enabled || !isRecord(payload)) return payload;
  const tier = options.tier ?? FAST_SERVICE_TIER;
  if (!getFastAvailability(options.model, options.usingOAuth, tier).active) return payload;
  if (payload.service_tier === tier) return payload;
  return { ...payload, service_tier: tier };
}

export function restoreFastModeState(branch: Iterable<unknown>): FastModeState | null {
  let latest: FastModeState | null = null;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_MODE_STATE_ENTRY) continue;
    if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") continue;
    const tier = entry.data.tier;
    if (tier !== undefined && tier !== FAST_SERVICE_TIER && tier !== ULTRAFAST_SERVICE_TIER) continue;
    latest = tier === undefined
      ? { enabled: entry.data.enabled }
      : { enabled: entry.data.enabled, tier };
  }
  return latest;
}
