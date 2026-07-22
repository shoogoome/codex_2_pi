// Shared types for the hooks-runner extension. These are plain data shapes so
// every src/ module stays pure and unit-testable without pulling in pi.

/**
 * The subset of Claude hook event names this MVP bridges. Claude defines many
 * more (SubagentStart, Notification, …) but pi only surfaces the lifecycle
 * events below, so we cap the vocabulary to what we can actually fire.
 */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "PreCompact";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "PreCompact",
] as const;

export type HookType = "command" | "prompt" | "agent" | "http";

/** Executed by spawning a shell; the only fully-implemented executor in the MVP. */
export interface CommandHook {
  type: "command";
  command: string;
  /** Optional permission-rule pre-filter, e.g. "Bash(git *)". */
  if?: string;
  /** Per-hook timeout in seconds (Claude uses seconds). */
  timeout?: number;
  shell?: string;
  statusMessage?: string;
}

/** LLM prompt hook — parsed but not executed in the MVP (phase 2). */
export interface PromptHook {
  type: "prompt";
  prompt: string;
  if?: string;
  timeout?: number;
  model?: string;
}

/** Agentic verifier hook — parsed but not executed in the MVP (phase 2). */
export interface AgentHook {
  type: "agent";
  prompt: string;
  if?: string;
  timeout?: number;
  model?: string;
}

/** HTTP POST hook — parsed but not executed in the MVP (phase 2). */
export interface HttpHook {
  type: "http";
  url: string;
  if?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export type Hook = CommandHook | PromptHook | AgentHook | HttpHook;

/** One matcher block: which tool/query it targets and the hooks it runs. */
export interface HookMatcher {
  matcher?: string;
  if?: string;
  hooks: Hook[];
}

/** Full parsed config: event name → list of matcher blocks. */
export type HooksConfig = Partial<Record<HookEventName, HookMatcher[]>>;

/**
 * Normalized decision after running a hook, independent of the wire protocol.
 * index.ts maps this onto the appropriate pi return value per event.
 */
export interface HookDecision {
  /** Hard stop: PreToolUse deny, exit 2, continue:false, or decision:block. */
  block?: boolean;
  /** Human-readable reason for a block (fed back to the model / notified). */
  reason?: string;
  /** Text to inject as extra context on the next agent turn. */
  additionalContext?: string;
  /** PreToolUse-only: replacement tool arguments (mutated in place by index.ts). */
  updatedInput?: Record<string, unknown>;
  /** Mirrors Claude's `continue`; false is treated as a block. */
  continue?: boolean;
  /** Mirrors Claude's `systemMessage` — surfaced via notify. */
  systemMessage?: string;
  /** SessionStart-only: a message to seed the first user turn with. */
  initialUserMessage?: string;
}

/** Raw result of executing a single command hook (pre-decode). */
export interface HookExecResult {
  /** True when the executor deliberately did not run (e.g. non-command type). */
  skipped?: boolean;
  skipReason?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Minimal shape read off a session branch for trust replay. */
export interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
