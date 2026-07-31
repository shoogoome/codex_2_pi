export const ULTRA_STATE_ENTRY = "ultra/state";
export const LEGACY_ULTRA_STATE_ENTRY = "effort/ultra";
export const ULTRA_STATUS_KEY = "codex-ultra";
export const ULTRA_IGNITION_WIDGET_KEY = "codex-ultra-ignition";

export const NATIVE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type NativeThinkingLevel = (typeof NATIVE_THINKING_LEVELS)[number];

const PROACTIVE_MULTI_AGENT_MODE_TEXT =
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode developer message changes it.";

const EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT =
  "Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.";

function modePrompt(text: string): string {
  return ["<multi_agent_mode>", text, "</multi_agent_mode>"].join("\n");
}

export const ULTRA_MODE_PROMPT = modePrompt(PROACTIVE_MULTI_AGENT_MODE_TEXT);
export const EXPLICIT_MULTI_AGENT_MODE_PROMPT = modePrompt(
  EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT,
);

export interface UltraState {
  enabled: boolean;
  /** Non-Ultra session default restored on graceful shutdown. */
  fallbackLevel?: NativeThinkingLevel;
}

interface ModelRef {
  id: string;
  provider?: string;
}

/** Codex 0.144 advertises Ultra only for subscription Sol and Terra. */
export function isUltraCapableModel(model: ModelRef | undefined): boolean {
  if (!model || model.provider !== "openai-codex") return false;
  const id = model.id.toLowerCase();
  return id === "gpt-5.6-sol" || id === "gpt-5.6-terra";
}

const MULTI_AGENT_MODE_BLOCK = /(?:\n{2})?<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g;

/** Keep one effective mode block even if another integration already added one. */
export function upsertMultiAgentModePrompt(
  systemPrompt: string,
  mode: "proactive" | "explicit",
): string {
  const prompt = mode === "proactive" ? ULTRA_MODE_PROMPT : EXPLICIT_MULTI_AGENT_MODE_PROMPT;
  const base = systemPrompt.replace(MULTI_AGENT_MODE_BLOCK, "").trimEnd();
  return base ? `${base}\n\n${prompt}` : prompt;
}

export function restoreUltraStateFromBranch(branch: Iterable<unknown>): UltraState | null {
  let latest: UltraState | null = null;
  for (const entry of branch) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || (entry.customType !== ULTRA_STATE_ENTRY && entry.customType !== LEGACY_ULTRA_STATE_ENTRY)
    ) continue;
    if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") continue;
    const fallbackLevel = isNativeThinkingLevel(entry.data.fallbackLevel)
      ? entry.data.fallbackLevel
      : undefined;
    latest = fallbackLevel
      ? { enabled: entry.data.enabled, fallbackLevel }
      : { enabled: entry.data.enabled };
  }
  return latest;
}

export function isNativeThinkingLevel(value: unknown): value is NativeThinkingLevel {
  return typeof value === "string"
    && (NATIVE_THINKING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
