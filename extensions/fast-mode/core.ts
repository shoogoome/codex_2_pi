import type { Model } from "@earendil-works/pi-ai";

export const FAST_MODE_STATE_ENTRY = "fast-mode-state";
export const FAST_SERVICE_TIER = "priority";

const FAST_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

export interface FastModeState {
  enabled: boolean;
}

export type FastModel = Pick<Model<any>, "api" | "id" | "provider">;

export type FastAvailability =
  | { active: true }
  | { active: false; reason: "no-model" | "unsupported-model" | "oauth-required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFastCapableModel(model: FastModel | undefined): boolean {
  return model?.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && FAST_MODEL_IDS.has(model.id);
}

export function getFastAvailability(
  model: FastModel | undefined,
  usingOAuth: boolean,
): FastAvailability {
  if (!model) return { active: false, reason: "no-model" };
  if (!isFastCapableModel(model)) return { active: false, reason: "unsupported-model" };
  if (!usingOAuth) return { active: false, reason: "oauth-required" };
  return { active: true };
}

export function applyFastServiceTier(
  payload: unknown,
  options: {
    enabled: boolean;
    model: FastModel | undefined;
    usingOAuth: boolean;
  },
): unknown {
  if (!options.enabled || !isRecord(payload)) return payload;
  if (!getFastAvailability(options.model, options.usingOAuth).active) return payload;
  if (payload.service_tier === FAST_SERVICE_TIER) return payload;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export function restoreFastModeState(branch: Iterable<unknown>): FastModeState | null {
  let latest: FastModeState | null = null;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_MODE_STATE_ENTRY) continue;
    if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") continue;
    latest = { enabled: entry.data.enabled };
  }
  return latest;
}
