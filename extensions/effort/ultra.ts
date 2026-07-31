export const ULTRA_STATE_ENTRY = "effort/ultra";
export const ULTRA_STATUS_KEY = "effort-ultra";

export const ULTRA_MODE_PROMPT = [
  "<multi_agent_mode>",
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode developer message changes it.",
  "</multi_agent_mode>",
].join("\n");

export interface UltraState {
  enabled: boolean;
}

interface ModelRef {
  id: string;
}

export function isUltraCapableModel(model: ModelRef | undefined): boolean {
  const id = model?.id.toLowerCase();
  return id === "gpt-5.6-sol" || id === "gpt-5.6-terra";
}

export function appendUltraModePrompt(systemPrompt: string): string {
  if (systemPrompt.includes(ULTRA_MODE_PROMPT)) return systemPrompt;
  const base = systemPrompt.trimEnd();
  return base ? `${base}\n\n${ULTRA_MODE_PROMPT}` : ULTRA_MODE_PROMPT;
}

export function restoreUltraStateFromBranch(branch: Iterable<unknown>): UltraState | null {
  let latest: UltraState | null = null;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== ULTRA_STATE_ENTRY) continue;
    if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") continue;
    latest = { enabled: entry.data.enabled };
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
