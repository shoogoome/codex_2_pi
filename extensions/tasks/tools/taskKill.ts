import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTerminalTaskStatus } from "../Task.js";
import type { TaskStore } from "../taskStore.js";
import { getTaskType } from "../taskTypeRegistry.js";
import { logError } from "../logging.js";

const TaskKillParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to kill (returned by spawn tools)." }),
});

export function buildTaskKillTool(store: TaskStore): ToolDefinition<typeof TaskKillParams, { action: string }> {
  return {
    name: "task_kill",
    label: "Kill task",
    description:
      "Force-stop a running task by ID. Works across all task types (bash, agent, teammate, ...)." +
      "\n\n## When to use\n\n" +
      "- **Teammate unresponsive / stuck in a long command**: `task_kill` is the correct, immediate remedy. It does NOT need the teammate's cooperation, so it works even when the teammate cannot read messages. Ask the leader for the decision on whether to kill, then call this.\n" +
      "- **Graceful stop is still preferred when the teammate is responsive**: `send_message {to:\"<name>\", message:'{\"type\":\"shutdown_request\",\"request_id\":\"r1\"}'}` lets it ack and exit cleanly. It is a REQUEST — if the teammate is inside a long-running tool call it will not see it until that call returns.\n" +
      "- **Do not use task_kill just to read progress.** Use `task_status` for that; killing is terminal.\n" +
      "- **Whole team**: `team_delete` cascade-kills every member.",
    parameters: TaskKillParams,
    promptSnippet: "Force-stop a running task or teammate by ID (no cooperation needed)",
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId, rawParams): Promise<AgentToolResult<{ action: string }>> {
      const { task_id } = rawParams as { task_id: string };
      const task = store.getTask(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_id}` }], details: { action: "kill" } };
      }
      if (isTerminalTaskStatus(task.status)) {
        return {
          content: [{ type: "text", text: `Task already ${task.status}: ${task_id}` }],
          details: { action: "kill" },
        };
      }
      const Task = getTaskType(task.type);
      if (!Task) {
        return {
          content: [{ type: "text", text: `Task type ${task.type} not registered` }],
          details: { action: "kill" },
        };
      }
      try {
        await Task.kill(task_id, store);
      } catch (e) {
        logError(e, "task_kill");
        return {
          content: [{ type: "text", text: `Failed to kill ${task_id}: ${(e as Error)?.message ?? String(e)}` }],
          details: { action: "kill" },
        };
      }
      return { content: [{ type: "text", text: `Killed: ${task_id}` }], details: { action: "kill" } };
    },
  };
}
