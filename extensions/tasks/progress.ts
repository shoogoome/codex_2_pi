// Task progress messages — pushed to TUI/RPC via sendMessage(deliverAs:"nextTurn", triggerTurn:false).
//
// Spike-verified at extensions/spike-progress-context/ that this primitive does NOT enter
// the parent LLM's next provider request payload — the message lands in the session jsonl
// + TUI renderer + RPC stdout, but `messages[]` of `before_provider_request` never sees it.
//
// Use this for in-flight progress (sub-agent tool calls, sub-shell milestones). For terminal
// status, use `notifyTaskTerminal` in `notifications.ts` (it has CAS guard + LLM context routing).
//
// Rendering layer: this customType is the *data plane* — events still hit the session jsonl
// (used by hydrate / debug tooling) and `installProgressContextFilter` strips them from the
// LLM payload. It does NOT paint to the main chat stream anymore — running status surfaces
// in the task panel widget (live tokenCount + lastTool) and terminal state surfaces via the
// `tasks/summary` customType (one compact line + Ctrl+O to expand).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * Emit a progress message to TUI/RPC.
 *
 * Mechanism (validated by spike `extensions/spike-progress-channels/`):
 *   - `display:true, triggerTurn:false` (no `deliverAs`) → message renders to TUI/RPC
 *     immediately AND is appended to the session jsonl as `{role:"custom", customType, ...}`.
 *   - That `role:"custom"` entry IS visible to the next provider request — it would enter
 *     the parent LLM's context.
 *   - `installProgressContextFilter(pi)` MUST be called once at extension load to register
 *     a `pi.on("context")` handler that strips these entries before LLM sees them.
 *
 * Why not `deliverAs:"nextTurn"`? Empirically the message gets queued silently — no TUI
 * render, no jsonl entry, no provider request entry — until the user types something and
 * then it's discarded. Useless for our purpose.
 *
 * Defensive try/catch — sendMessage failure must NOT propagate up to the producer (the
 * spawn function is mid-LLM-loop and we don't want a renderer crash to kill the agent).
 */
export function emitTaskProgress(
  pi: Pick<ExtensionAPI, "sendMessage">,
  d: Omit<TaskProgressDetails, "ts"> & { ts?: number },
): void {
  const details: TaskProgressDetails = { ts: Date.now(), ...d };
  try {
    pi.sendMessage(
      {
        customType: TASK_PROGRESS_CUSTOM_TYPE,
        content: details.summary,
        display: true,
        details,
      } as never,
      { triggerTurn: false },
    );
  } catch (e) {
    logError(e, "emitTaskProgress");
  }
}

/**
 * Install the `context` event filter that strips progress messages from the LLM's
 * provider request payload. Pair with `emitTaskProgress` — if you emit but don't
 * install the filter, the LLM will see the progress entries.
 *
 * AgentMessage shape for custom messages: `{role:"custom", customType, content, ...}`.
 * This filter drops any message with `role==="custom"` and our customType.
 */
export function installProgressContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as { role?: string; customType?: string };
      return !(msg.role === "custom" && msg.customType === TASK_PROGRESS_CUSTOM_TYPE);
    });
    return { messages: filtered as never };
  });
}

// ---------- TUI Renderer ----------
//
// Per the new layered design (commit feat(tasks): live status in panel widget; one summary
// in main stream on terminal): the per-event progress stream no longer paints to the main
// chat stream. Running tasks show live in the panel widget; terminal tasks emit a single
// `tasks/summary` customMessage with collapsible timeline.
//
// We keep the `tasks/progress` customType + `emitTaskProgress` + `installProgressContextFilter`
// intact because the data still hits the session jsonl (debug tooling, hydration). Only the
// visual layer is removed — `registerTaskProgressRenderer` now returns `undefined` so Pi's
// renderer pipeline skips it.

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
