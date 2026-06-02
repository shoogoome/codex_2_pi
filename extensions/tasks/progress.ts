// Task progress messages — pushed to TUI/RPC via sendMessage(deliverAs:"nextTurn", triggerTurn:false).
//
// Spike-verified at extensions/spike-progress-context/ that this primitive does NOT enter
// the parent LLM's next provider request payload — the message lands in the session jsonl
// + TUI renderer + RPC stdout, but `messages[]` of `before_provider_request` never sees it.
//
// Use this for in-flight progress (sub-agent tool calls, sub-shell milestones). For terminal
// status, use `notifyTaskTerminal` in `notifications.ts` (it has CAS guard + LLM context routing).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
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

const KIND_PREFIX: Record<TaskProgressKind, string> = {
  task_start: "▶",
  tool_start: "  ↳",
  tool_end: "  ✓",
  stream: "  ·",
  task_end: "■",
  kill: "✗",
};

function renderHeadline(d: TaskProgressDetails): string {
  const tag = d.taskType === "local_agent" ? "agent" : d.taskType === "local_bash" ? "bash" : d.taskType;
  const kindMark = KIND_PREFIX[d.kind] ?? "·";
  return `[${tag} ${d.taskId}] ${kindMark} ${d.summary}`;
}

/**
 * Register the TUI renderer for tasks/progress customType.
 *
 * Style: single-line `[type taskId] {kind-icon} {summary}`. Color follows kind:
 *   - tool_end with isError → "error"
 *   - kill → "error"
 *   - task_end → "success"
 *   - others → "dim" (informational, low contrast)
 *
 * Expanded view shows a Box with the headline + extra details (agentType / toolName / etc.).
 * Behavior aligned with `registerTaskNotificationRenderer` in `notifications.ts`.
 */
export function registerTaskProgressRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  pi.registerMessageRenderer<TaskProgressDetails>(
    TASK_PROGRESS_CUSTOM_TYPE,
    (message, { expanded }, theme): Component | undefined => {
      const d = message.details;
      if (!d) {
        const text = typeof message.content === "string" ? message.content : "";
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }
      const colorKey: "success" | "error" | "dim" =
        d.kind === "kill" || (d.kind === "tool_end" && d.isError)
          ? "error"
          : d.kind === "task_end"
            ? "success"
            : "dim";
      const headline = renderHeadline(d);

      if (!expanded) {
        return new Text(theme.fg(colorKey, headline), 0, 0);
      }

      const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
      box.addChild(new Text(theme.fg(colorKey, theme.bold(headline)), 0, 0));
      const meta: string[] = [];
      if (d.agentType) meta.push(`agentType=${d.agentType}`);
      if (d.toolName) meta.push(`tool=${d.toolName}`);
      if (d.exitCode !== undefined) meta.push(`exit=${d.exitCode}`);
      if (d.toolCallCount !== undefined) meta.push(`tools=${d.toolCallCount}`);
      if (d.tokenCount !== undefined && d.tokenCount > 0) meta.push(`tokens=${d.tokenCount}`);
      if (d.durationMs !== undefined) meta.push(`durationMs=${d.durationMs}`);
      if (meta.length > 0) {
        box.addChild(new Text(theme.fg("dim", meta.join("  ")), 0, 0));
      }
      return box;
    },
  );
}
