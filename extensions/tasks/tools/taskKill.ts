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
      "Stop a running task by ID. Works across all task types (bash, agent, ...)." +
      "\n\n## Polling caveat\n\n" +
      "- For teammates, prefer the graceful protocol: `send_message {to:\"<name>\", message:'{\"type\":\"shutdown_request\",\"request_id\":\"r1\"}'}` — the teammate's loop auto-acks and exits. Use task_kill only as a forced last resort (or via team_delete cascade for the whole team).",
    parameters: TaskKillParams,
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
