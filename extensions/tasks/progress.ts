// Task progress records — persisted via appendEntry and rendered by the task panel.
//
// Spike-verified at extensions/spike-progress-context/ that this primitive does NOT enter
// the parent LLM's next provider request payload — the message lands in the session jsonl
// + TUI renderer + RPC stdout, but `messages[]` of `before_provider_request` never sees it.
//
// Use this for in-flight progress (sub-agent tool calls, sub-shell milestones). For terminal
// status, use `notifyTaskTerminal` in `notifications.ts` (it has CAS guard + LLM context routing).
//
// Rendering layer: progress is persisted as a `custom` entry via appendEntry, which Pi's
// session-context builder ignores for both normal requests and compaction. It does NOT paint
// to the main chat stream anymore — running status surfaces in the task panel widget
// (live tokenCount + lastTool) and terminal state surfaces via the `tasks/summary` customType.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCustomTypeContextFilter } from "./contextFilter.js";
import { logError } from "./logging.js";
import type { TaskType } from "./Task.js";

export const TASK_PROGRESS_CUSTOM_TYPE = "tasks/progress";

export type TaskProgressKind =
  | "task_start"
  | "tool_start"
  | "tool_end"
  | "stream"
  | "task_end"
  | "kill";

export interface TaskProgressDetails {
  taskId: string;
  taskType: TaskType;
  kind: TaskProgressKind;
  /** Human-readable single-line summary, e.g. `grep("foo")` or `[ok] grep → 12 results`. */
  summary: string;
  description?: string;
  agentType?: string;
  toolName?: string;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  toolCallCount?: number;
  tokenCount?: number;
  ts: number;
}

/**
 * Persist a progress record without creating a `custom_message`.
 *
 * Pi's compaction code reads the raw session branch and does not run `context`
 * handlers. Therefore progress must use `appendEntry` (a `custom` entry), not
 * `sendMessage` (a `custom_message` that would be counted during compaction).
 * Live progress is rendered by the task panel from the task store.
 */
export function emitTaskProgress(
  pi: Pick<ExtensionAPI, "appendEntry">,
  d: Omit<TaskProgressDetails, "ts"> & { ts?: number },
): void {
  const details: TaskProgressDetails = { ts: Date.now(), ...d };
  try {
    pi.appendEntry(TASK_PROGRESS_CUSTOM_TYPE, {
      content: details.summary,
      details,
    });
  } catch (e) {
    logError(e, "emitTaskProgress");
  }
}

/**
 * Install the `context` event filter that strips progress messages from the LLM's
 * provider request payload. Pair with `emitTaskProgress` — if you emit but don't
 * install the filter, the LLM will see the progress entries.
 *
 * Thin wrapper over `installCustomTypeContextFilter` — kept as a named export so
 * existing callers / tests don't have to change. The shared primitive is reused
 * by `tasks/summary` (and any future debug-only customType).
 */
export function installProgressContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  installCustomTypeContextFilter(pi, TASK_PROGRESS_CUSTOM_TYPE);
}

// ---------- TUI Renderer ----------
//
// Per the new layered design (commit feat(tasks): live status in panel widget; one summary
// in main stream on terminal): the per-event progress stream no longer paints to the main
// chat stream. Running tasks show live in the panel widget; terminal tasks emit a single
// `tasks/summary` customMessage with collapsible timeline.
//
// We keep the `tasks/progress` customType + `emitTaskProgress` + `installProgressContextFilter`
// intact for compatibility with old sessions. New progress records use appendEntry and are
// ignored by Pi's session-context builder; the filter still removes legacy custom messages.

/**
 * Register the (now-noop) TUI renderer for tasks/progress customType.
 *
 * The renderer always returns `undefined` — Pi's pipeline treats this as "no visual"
 * and the message contributes only to jsonl + the LLM-context-filter pass. Live progress
 * is surfaced via the task panel widget (running) and `tasks/summary` (terminal).
 */
export function registerTaskProgressRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  pi.registerMessageRenderer<TaskProgressDetails>(
    TASK_PROGRESS_CUSTOM_TYPE,
    () => undefined,
  );
}
