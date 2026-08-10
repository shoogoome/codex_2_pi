import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TeamTask } from "../types.js";
import {
  canAccessTeam,
  resolveTeamTaskHandle,
  type TeamTaskToolBinding,
} from "./teamTaskBinding.js";

const TeamTaskGetParams = Type.Object({
  task_id: Type.String({
    description: "Target task id (e.g. 'tt-3akj9d2x').",
  }),
});

interface TeamTaskGetDetails {
  action: "team_task_get";
  task?: TeamTask;
}

const DESCRIPTION =
  "Get full details of one team task by id.\n\n" +
  "Returns: id, team, subject, description, status, owner, blocked_by, blocks, metadata, createdAt, updatedAt.\n\n" +
  "Use team_task_list to discover task ids; use this tool to read a single task in full when team_task_list's truncated view isn't enough.\n\n" +
  "Errors if task_id doesn't exist.";

function renderTask(task: TeamTask): string {
  const description = task.description ?? "(none)";
  const owner = task.owner ?? "(none)";
  const metadata =
    task.metadata === undefined ? "(none)" : JSON.stringify(task.metadata);
  const blockedBy = JSON.stringify(task.blockedBy);
  const blocks = JSON.stringify(task.blocks);
  const created = new Date(task.createdAt).toISOString();
  const updated = new Date(task.updatedAt).toISOString();
  return (
    `Task ${task.id}\n` +
    `  team:        ${task.teamName}\n` +
    `  subject:     ${task.subject}\n` +
    `  description: ${description}\n` +
    `  status:      ${task.status}\n` +
    `  owner:       ${owner}\n` +
    `  blocked_by:  ${blockedBy}\n` +
    `  blocks:      ${blocks}\n` +
    `  metadata:    ${metadata}\n` +
    `  created:     ${created}\n` +
    `  updated:     ${updated}`
  );
}

export function buildTeamTaskGetTool(
  pi: ExtensionAPI,
  binding?: TeamTaskToolBinding,
): ToolDefinition<typeof TeamTaskGetParams, TeamTaskGetDetails> {
  return {
    name: "team_task_get",
    label: "Get full details of one team task",
    description: DESCRIPTION,
    parameters: TeamTaskGetParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { task_id?: string };
      const taskId = params.task_id?.trim() ?? "";

      if (taskId.length === 0) {
        return {
          content: [{ type: "text" as const, text: "task_id must be non-empty" }],
          isError: true,
          details: { action: "team_task_get" as const },
        };
      }

      const handle = resolveTeamTaskHandle(pi, binding);
      const task = handle.teamTaskStore.getTask(taskId);
      if (!task || (binding && !canAccessTeam(binding, task.teamName))) {
        return {
          content: [
            {
              type: "text" as const,
              text: binding
                ? `Task '${taskId}' not found in team '${binding.identity.teamName}'`
                : `Task '${taskId}' not found`,
            },
          ],
          isError: true,
          details: { action: "team_task_get" as const },
        };
      }

      return {
        content: [{ type: "text" as const, text: renderTask(task) }],
        details: { action: "team_task_get" as const, task },
      };
    },
  };
}
