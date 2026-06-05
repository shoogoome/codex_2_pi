// Task summary — one-shot custom message written to the main chat stream when a task
// transitions to a terminal status (completed / killed / failed). Replaces the per-event
// `tasks/progress` paint, surfacing a compact head line + collapsible timeline body.
//
// Layered design (pair with `progress.ts`):
//   - tasks/progress  → live data plane (jsonl + LLM-context filter), no main-stream paint
//   - tasks/summary   → main-stream surface, one row per terminated task
//   - panel widget    → live status while running (read from LocalAgentTaskState.progress)
//
// Why a separate customType (instead of reusing tasks/progress with a kind=summary):
//   - Renderers are 1:1 with customType. Splitting summary out lets `tasks/progress` be
//     a true noop renderer while `tasks/summary` remains visible.
//   - Context filter is per-customType — leader doesn't need either in the LLM payload.

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { logError } from "./logging.js";
import type { TaskType } from "./Task.js";
import type { TaskProgressKind } from "./progress.js";

export const TASK_SUMMARY_CUSTOM_TYPE = "tasks/summary";

export interface TaskSummaryTimelineEntry {
  kind: TaskProgressKind;
  summary: string;
  isError?: boolean;
  ts: number;
}

export interface TaskSummaryDetails {
  taskId: string;
  taskType: TaskType;
  status: "completed" | "killed" | "failed";
  description?: string;
  agentType?: string;
  toolCallCount: number;
  tokenCount: number;
  durationMs: number;
  /** Captured progress events bundled into this terminal summary. Used in expanded view. */
  timeline: ReadonlyArray<TaskSummaryTimelineEntry>;
  ts: number;
}

/**
 * Emit a terminal summary message for `taskId`. Mirrors `emitTaskProgress` in delivery
 * semantics: `display:true, triggerTurn:false` — surfaces in TUI/RPC + jsonl. The paired
 * `installTaskSummaryContextFilter` strips the entry from the LLM provider payload.
 */
export function emitTaskSummary(
  pi: Pick<ExtensionAPI, "sendMessage">,
  d: Omit<TaskSummaryDetails, "ts"> & { ts?: number },
): void {
  const details: TaskSummaryDetails = { ts: Date.now(), ...d };
  try {
    pi.sendMessage(
      {
        customType: TASK_SUMMARY_CUSTOM_TYPE,
        content: details.description ?? details.agentType ?? details.taskType,
        display: true,
        details,
      } as never,
      { triggerTurn: false },
    );
  } catch (e) {
    logError(e, "emitTaskSummary");
  }
}

// ---------- Renderer ----------

function statusGlyph(status: TaskSummaryDetails["status"]): {
  glyph: string;
  color: ThemeColor;
} {
  if (status === "completed") return { glyph: "✓", color: "success" };
  if (status === "killed") return { glyph: "■", color: "warning" };
  return { glyph: "✗", color: "error" };
}

function formatTokens(n: number): string {
  if (n <= 0) return "0 tokens";
  if (n < 1000) return `${n} tokens`;
  return `${(n / 1000).toFixed(1)}k tokens`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

function themeBold(theme: Theme, value: string): string {
  return ((theme as { bold?: (v: string) => string }).bold?.(value)) ?? value;
}

function buildHead(d: TaskSummaryDetails, theme: Theme): string {
  const { glyph, color } = statusGlyph(d.status);
  const label = d.agentType ?? d.description ?? d.taskType;
  const stats: string[] = [];
  if (d.toolCallCount > 0)
    stats.push(`${d.toolCallCount} tool${d.toolCallCount === 1 ? "" : "s"}`);
  if (d.tokenCount > 0) stats.push(formatTokens(d.tokenCount));
  if (d.durationMs > 0) stats.push(formatDuration(d.durationMs));
  const dot = ` ${theme.fg("dim", "·")} `;
  const statsLine = stats.map((s) => theme.fg("dim", s)).join(dot);
  const head = `${theme.fg(color, glyph)} ${themeBold(theme, theme.fg(color, label))}`;
  // Show description as a dim subtitle when both agentType and description exist.
  const subtitle =
    d.description && d.agentType && d.description !== d.agentType
      ? `${dot}${theme.fg("dim", d.description)}`
      : "";
  const trailing = stats.length > 0 ? `  ${theme.fg("dim", "·")}  ${statsLine}` : "";
  return `${head}${subtitle}${trailing}`;
}

function timelineGlyph(e: TaskSummaryTimelineEntry): { glyph: string; color: ThemeColor } {
  switch (e.kind) {
    case "task_start":
      return { glyph: "▶", color: "accent" };
    case "tool_start":
      return { glyph: "●", color: "accent" };
    case "tool_end":
      return e.isError ? { glyph: "✗", color: "error" } : { glyph: "✓", color: "success" };
    case "task_end":
      return { glyph: "✓", color: "success" };
    case "kill":
      return { glyph: "■", color: "warning" };
    case "stream":
    default:
      return { glyph: "·", color: "dim" };
  }
}

/**
 * Register the TUI renderer for `tasks/summary`. Collapsed view = head + (optional) hint;
 * expanded view (Ctrl+O) = head + each timeline event indented under `⎿`.
 */
export function registerTaskSummaryRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  pi.registerMessageRenderer<TaskSummaryDetails>(
    TASK_SUMMARY_CUSTOM_TYPE,
    (message, { expanded }, theme): Component | undefined => {
      const d = message.details;
      if (!d) return undefined;

      const head = buildHead(d, theme);

      if (!expanded) {
        if (d.timeline.length === 0) {
          return new Text(head, 0, 0);
        }
        const hint = theme.fg(
          "dim",
          `(${d.timeline.length} events · Ctrl+O to expand)`,
        );
        const box = new Box(0, 0);
        box.addChild(new Text(head, 0, 0));
        box.addChild(new Text(`  ${hint}`, 0, 0));
        return box;
      }

      // Expanded: head + each timeline event indented.
      const box = new Box(0, 0);
      box.addChild(new Text(head, 0, 0));
      for (const e of d.timeline) {
        const { glyph, color } = timelineGlyph(e);
        box.addChild(
          new Text(
            `  ${theme.fg("dim", "⎿")}  ${theme.fg(color, glyph)} ${theme.fg("dim", e.summary)}`,
            0,
            0,
          ),
        );
      }
      return box;
    },
  );
}

/**
 * Strip `tasks/summary` entries from the LLM context — leader doesn't need to re-read its
 * own task summaries; the sub-agent's `finalText` already returned via `task_agent`'s tool
 * result and the `tasks/notification` already carries the structured terminal status.
 */
export function installTaskSummaryContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as { role?: string; customType?: string };
      return !(msg.role === "custom" && msg.customType === TASK_SUMMARY_CUSTOM_TYPE);
    });
    return { messages: filtered as never };
  });
}
