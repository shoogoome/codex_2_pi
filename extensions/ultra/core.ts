export const ULTRA_STATE_ENTRY = "ultra/state";
export const LEGACY_ULTRA_STATE_ENTRY = "effort/ultra";
export const ULTRA_STATUS_KEY = "codex-ultra";
export const ULTRA_IGNITION_WIDGET_KEY = "codex-ultra-ignition";
export const TASK_AGENT_TOOL_NAME = "task_agent";
export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";

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

export const ULTRA_WORKFLOW_PROMPT = [
  "<ultra_multi_agent_workflow>",
  "The Ultra multi-agent workflow is active.",
  "For a non-trivial task with at least two independent workstreams, issue multiple task_agent calls in parallel in a single assistant message. Each call forks the current session, inherits its provider/model configuration, and runs in background automatically. Keep advancing independent main-agent work while they run, then synthesize their results after automatic completion notifications arrive.",
  "Do not parallelize simple tasks or work with strong sequential dependencies merely for the sake of parallelism. Do not poll forked agents or teammates for status; use their automatic notifications.",
  "</ultra_multi_agent_workflow>",
].join("\n");

export interface UltraState {
  enabled: boolean;
  /** Non-Ultra session default restored on graceful shutdown. */
  fallbackLevel?: NativeThinkingLevel;
}

interface ModelRef {
  id: string;
  provider?: string;
}

/** Ultra is available for any active model; native max support is checked at enable time. */
export function isUltraCapableModel(model: ModelRef | undefined): boolean {
  return Boolean(model?.id);
}

const MULTI_AGENT_MODE_BLOCK = /(?:\n{2})?<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g;
const ULTRA_WORKFLOW_BLOCK =
  /(?:\n{2})?<ultra_multi_agent_workflow>[\s\S]*?<\/ultra_multi_agent_workflow>/g;

/** Keep one effective mode block even if another integration already added one. */
export function upsertMultiAgentModePrompt(
  systemPrompt: string,
  mode: "proactive" | "explicit",
): string {
  const prompt = mode === "proactive" ? ULTRA_MODE_PROMPT : EXPLICIT_MULTI_AGENT_MODE_PROMPT;
  const base = systemPrompt.replace(MULTI_AGENT_MODE_BLOCK, "").trimEnd();
  return base ? `${base}\n\n${prompt}` : prompt;
}

/** Add one Ultra-owned workflow block, or remove it when the workflow is unavailable. */
export function upsertUltraWorkflowPrompt(systemPrompt: string, active: boolean): string {
  const base = systemPrompt.replace(ULTRA_WORKFLOW_BLOCK, "").trimEnd();
  if (!active) return base;
  return base ? `${base}\n\n${ULTRA_WORKFLOW_PROMPT}` : ULTRA_WORKFLOW_PROMPT;
}

export type UltraWorkflowState =
  | "active"
  | "paused-plan-mode"
  | "paused-task-agent-inactive"
  | "paused-task-agent-unavailable";

/** Inspect workflow availability without changing the user's active-tool selection. */
export function getUltraWorkflowState(
  activeTools: readonly string[],
  availableTools: readonly string[],
): UltraWorkflowState {
  if (activeTools.includes(EXIT_PLAN_MODE_TOOL_NAME)) return "paused-plan-mode";
  if (!availableTools.includes(TASK_AGENT_TOOL_NAME)) return "paused-task-agent-unavailable";
  if (!activeTools.includes(TASK_AGENT_TOOL_NAME)) return "paused-task-agent-inactive";
  return "active";
}

/** Return the minimally changed tool set needed to activate Ultra, if activation is safe. */
export function toolsForUltraTaskAgentActivation(
  activeTools: readonly string[],
  availableTools: readonly string[],
): string[] | undefined {
  if (getUltraWorkflowState(activeTools, availableTools) !== "paused-task-agent-inactive") {
    return undefined;
  }
  return [...activeTools, TASK_AGENT_TOOL_NAME];
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
