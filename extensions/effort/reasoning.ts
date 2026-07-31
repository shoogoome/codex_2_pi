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
export type EffortLevel = NativeThinkingLevel | "ultra";

export interface ReasoningModelRef {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<NativeThinkingLevel, string | null>>;
}

export interface ReasoningOption {
  level: EffortLevel;
  label: string;
  description: string;
  advanced: boolean;
}

const LABELS: Record<EffortLevel, string> = {
  off: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const DESCRIPTIONS: Record<EffortLevel, string> = {
  off: "Disable model reasoning",
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "For difficult problems when quality matters more than speed · higher usage",
  ultra: "For demanding work using multiple agents · highest usage",
};

const CODEX_GPT_56_STANDARD_LEVELS: readonly NativeThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export function isNativeThinkingLevel(value: unknown): value is NativeThinkingLevel {
  return typeof value === "string"
    && (NATIVE_THINKING_LEVELS as readonly string[]).includes(value);
}

export function effortLabel(level: EffortLevel): string {
  return LABELS[level];
}

export function isAdvancedEffort(level: EffortLevel): boolean {
  return level === "max" || level === "ultra";
}

export function isCodexGpt56Model(model: ReasoningModelRef | undefined): boolean {
  if (!model || model.provider !== "openai-codex") return false;
  const id = model.id.toLowerCase();
  return id === "gpt-5.6-sol" || id === "gpt-5.6-terra" || id === "gpt-5.6-luna";
}

/**
 * Reasoning choices advertised by the active model.
 *
 * The Codex subscription catalog is authoritative for GPT-5.6: Sol/Terra expose
 * Low..Extra high plus the explicit Max/Ultra advanced tier, while Luna exposes
 * the same native levels without Ultra. Other Pi models fall back to their
 * thinkingLevelMap.
 */
export function reasoningOptionsForModel(
  model: ReasoningModelRef | undefined,
  ultraCapable: boolean,
): ReasoningOption[] {
  if (!model) return [];

  let nativeLevels: NativeThinkingLevel[];
  if (isCodexGpt56Model(model)) {
    nativeLevels = [...CODEX_GPT_56_STANDARD_LEVELS, "max"];
  } else if (!model.reasoning) {
    nativeLevels = ["off"];
  } else {
    nativeLevels = NATIVE_THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      // Pi only treats the two upper tiers as available when the model
      // advertises an explicit mapping for them.
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    });
  }

  const levels: EffortLevel[] = ultraCapable
    ? [...nativeLevels, "ultra"]
    : nativeLevels;
  return levels.map((level) => ({
    level,
    label: LABELS[level],
    description: DESCRIPTIONS[level],
    advanced: isAdvancedEffort(level),
  }));
}

export function defaultEffortForModel(
  options: readonly ReasoningOption[],
  preferred: EffortLevel | undefined,
): EffortLevel | undefined {
  if (preferred && options.some((option) => option.level === preferred)) return preferred;
  if (options.some((option) => option.level === "medium")) return "medium";
  return options.find((option) => !option.advanced)?.level ?? options[0]?.level;
}

export type ReasoningShortcutDirection = "lower" | "raise";

/**
 * Step through the model-advertised order. Callers deliberately refuse a
 * raise into Max/Ultra so those costly tiers remain behind the explicit picker.
 */
export function nextEffort(
  options: readonly ReasoningOption[],
  current: EffortLevel,
  direction: ReasoningShortcutDirection,
): EffortLevel | undefined {
  const index = options.findIndex((option) => option.level === current);
  if (index < 0) return undefined;
  const nextIndex = direction === "lower" ? index - 1 : index + 1;
  return options[nextIndex]?.level;
}
