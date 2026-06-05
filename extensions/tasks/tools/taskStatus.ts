import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TaskStore } from "../taskStore.js";
import { getTaskOutputDelta, flushTaskOutput } from "../diskOutput.js";
import { logError } from "../logging.js";

const TaskStatusParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to inspect." }),
  output_offset: Type.Optional(
    Type.Number({ description: "Byte offset; only data past this offset is returned." }),
  ),
});

interface TaskStatusDetails {
  action: "status";
  status?: string;
  type?: string;
  description?: string;
  startTime?: number;
  endTime?: number;
  notified?: boolean;
  output_delta: string;
  next_offset: number;
  total_size: number;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

const HEAD_LINES = 1;

function isThemeWithFg(t: unknown): t is RenderTheme {
  return typeof (t as { fg?: unknown } | null)?.fg === "function";
}

export function buildTaskStatusTool(store: TaskStore): ToolDefinition<typeof TaskStatusParams, TaskStatusDetails> {
  return {
    name: "task_status",
    label: "Task status",
    description:
      "Read a task's current status, terminal exit info, and incremental output past a byte offset." +
      "\n\n## Polling caveat\n\n" +
      "- Do NOT use task_status to poll teammate progress after send_message. Teammate replies are AUTOMATICALLY delivered to your context as new turns; just wait or work on other things.\n" +
      "- Do NOT use task_status to check if a teammate is idle. Idle notifications are auto-delivered with triggerTurn:false (informational). Polling adds noise without value.\n" +
      "- DO use task_status when: (a) you have an explicit reason to inspect a long-running local_bash task or local_agent sub-agent, (b) debugging a stuck task, or (c) verifying terminal state after kill.",
    parameters: TaskStatusParams,
    executionMode: "parallel",
    async execute(_callId, rawParams): Promise<AgentToolResult<TaskStatusDetails>> {
      const { task_id, output_offset } = rawParams as { task_id: string; output_offset?: number };
      const task = store.getTask(task_id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${task_id}` }],
          details: { action: "status", output_delta: "", next_offset: 0, total_size: 0 },
        };
      }
      let delta = "";
      let nextOffset = 0;
      try {
        await flushTaskOutput(task_id);
        const r = await getTaskOutputDelta(task_id, output_offset ?? 0);
        delta = r.content;
        nextOffset = r.newOffset;
      } catch (e) {
        logError(e, "task_status");
      }
      const details: TaskStatusDetails = {
        action: "status",
        status: task.status,
        type: task.type,
        description: task.description,
        startTime: task.startTime,
        endTime: task.endTime,
        notified: task.notified,
        output_delta: delta,
        next_offset: nextOffset,
        total_size: nextOffset,
      };
      const head = `${task.status} (${task.type}) — ${task.description}`;
      const tail = delta ? `\n${delta}` : "";
      return { content: [{ type: "text", text: head + tail }], details };
    },
    /**
     * Compact rendering — same head + Ctrl+O expand pattern as task_bash.
     * Without this Pi paints the FULL output_delta (often hundreds of lines
     * of `[tool] read(...)` / `[ok] read → ...` from the sub-agent's output
     * file) as one massive tool-result block per task_status call. Showing
     * only the status header keeps the main stream readable; users (and
     * the LLM, when it's actually debugging) can hit Ctrl+O to expand.
     */
    renderResult(
      result: AgentToolResult<TaskStatusDetails>,
      options: { isPartial: boolean; expanded: boolean },
      theme: Theme,
    ) {
      const t: RenderTheme = isThemeWithFg(theme)
        ? (theme as unknown as RenderTheme)
        : { fg: (_c, x) => x };
      if (options.isPartial) {
        return new Text(t.fg("dim", "task_status running…"), 0, 0);
      }
      const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
      const lines = text.split(/\r?\n/);
      // Short result (just the status header line, no output_delta) — render
      // inline as-is so users still see what the LLM saw without an extra
      // expand keystroke.
      if (lines.length <= HEAD_LINES + 1) {
        return new Text(t.fg("dim", text), 0, 0);
      }
      if (options.expanded) {
        return new Text(t.fg("dim", text), 0, 0);
      }
      const head = lines.slice(0, HEAD_LINES).join("\n");
      const hidden = lines.length - HEAD_LINES;
      const summary =
        `${t.fg("dim", head)}\n` +
        t.fg("dim", `… (${hidden} lines hidden · Ctrl+O to expand)`);
      return new Text(summary, 0, 0);
    },
  };
}
