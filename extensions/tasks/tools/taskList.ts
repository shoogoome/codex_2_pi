import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../taskStore.js";
import { isTerminalTaskStatus } from "../Task.js";

const TaskListParams = Type.Object({
  filter: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("all")])),
});

interface TaskListRow {
  id: string;
  type: string;
  status: string;
  description: string;
  startTime: number;
  endTime?: number;
}

interface TaskListDetails {
  action: "list";
  filter: "running" | "all";
  tasks: TaskListRow[];
}

export function buildTaskListTool(store: TaskStore): ToolDefinition<typeof TaskListParams, TaskListDetails> {
  return {
    name: "task_list",
    label: "List tasks",
    description: "List currently registered tasks. Filter='running' (default) or 'all'.",
    parameters: TaskListParams,
    executionMode: "parallel",
    async execute(_callId, rawParams): Promise<AgentToolResult<TaskListDetails>> {
      const { filter } = rawParams as { filter?: "running" | "all" };
      const f: "running" | "all" = filter ?? "running";
      const snapshot = store.get();
      const rows: TaskListRow[] = [];
      for (const t of Object.values(snapshot)) {
        if (f === "running" && isTerminalTaskStatus(t.status)) continue;
        rows.push({
          id: t.id,
          type: t.type,
          status: t.status,
          description: t.description,
          startTime: t.startTime,
          endTime: t.endTime,
        });
      }
      const text = rows.length
        ? rows.map((r) => `${r.id}  ${r.status}  ${r.type}  ${r.description}`).join("\n")
        : "No tasks";
      return { content: [{ type: "text", text }], details: { action: "list", filter: f, tasks: rows } };
    },
  };
}
