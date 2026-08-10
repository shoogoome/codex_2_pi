import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitTeammateEvent } from "../../eventEmit.js";
import type { TeamTask } from "../types.js";
import {
  canAccessTeam,
  findCrossTeamBlocker,
  resolveTeamTaskHandle,
  teamAccessError,
  type TeamTaskToolBinding,
} from "./teamTaskBinding.js";

const TeamTaskCreateParams = Type.Object({
  team_name: Type.String({
    description: "Target team name (must already exist via team_create).",
  }),
  subject: Type.String({
    description: "Short title of the task (one line).",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional detailed description / acceptance criteria.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        "Optional teammate agentName to assign to. Leave empty for unowned (any teammate can claim).",
    }),
  ),
  blocked_by: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional list of upstream team_task ids that must complete first.",
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional structured metadata (free-form JSON).",
    }),
  ),
});

interface TeamTaskCreateDetails {
  action: "team_task_create";
  taskId?: string;
  teamName?: string;
  subject?: string;
  owner?: string;
  blockedBy?: string[];
}

const DESCRIPTION =
  "Create a team task to track a unit of work for the team. Use this so the team has a shared, queryable task list visible to all teammates and the leader.\n\n" +
  "## When to use\n" +
  "- Leader breaks work down: create one task per unit, optionally set `owner` to assign to a specific teammate.\n" +
  "- An unowned task (no owner) is implicitly available — any teammate can claim it via team_task_update {owner: \"<self>\"}.\n" +
  "- Use `blocked_by` to express ordering: a task with non-empty blocked_by should not be picked up until all upstream tasks reach status \"completed\".\n\n" +
  "## Lifecycle\n" +
  "- Created tasks start in `status: \"pending\"`.\n" +
  "- Update status via team_task_update to \"in_progress\" / \"completed\".\n" +
  "- Other teammates see the change immediately via team_task_list.\n\n" +
  "Errors if team_name doesn't exist; subject is required.";

export function buildTeamTaskCreateTool(
  pi: ExtensionAPI,
  binding?: TeamTaskToolBinding,
): ToolDefinition<typeof TeamTaskCreateParams, TeamTaskCreateDetails> {
  return {
    name: "team_task_create",
    label: "Create a team task",
    description: DESCRIPTION,
    parameters: TeamTaskCreateParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as {
        team_name?: string;
        subject?: string;
        description?: string;
        owner?: string;
        blocked_by?: string[];
        metadata?: Record<string, unknown>;
      };

      const teamName = params.team_name?.trim() ?? "";
      const subject = params.subject?.trim() ?? "";

      if (subject.length === 0) {
        return {
          content: [{ type: "text" as const, text: "subject must be non-empty" }],
          isError: true,
          details: { action: "team_task_create" as const },
        };
      }
      if (teamName.length === 0) {
        return {
          content: [{ type: "text" as const, text: "team_name must be non-empty" }],
          isError: true,
          details: { action: "team_task_create" as const },
        };
      }

      const handle = resolveTeamTaskHandle(pi, binding);
      if (binding && !canAccessTeam(binding, teamName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: teamAccessError(binding, teamName),
            },
          ],
          isError: true,
          details: { action: "team_task_create" as const, teamName },
        };
      }
      if (!handle.teamStore.getTeam(teamName)) {
        return {
          content: [
            { type: "text" as const, text: `Team '${teamName}' does not exist` },
          ],
          isError: true,
          details: { action: "team_task_create" as const, teamName },
        };
      }

      const taskId = `tt-${randomBytes(6).toString("hex")}`;
      const now = Date.now();
      const blockedBy = params.blocked_by ?? [];
      const crossTeamBlocker = binding
        ? findCrossTeamBlocker(handle, teamName, blockedBy)
        : undefined;
      if (crossTeamBlocker) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Blocked task '${crossTeamBlocker}' is not accessible in team '${teamName}'`,
            },
          ],
          isError: true,
          details: {
            action: "team_task_create" as const,
            teamName,
            blockedBy,
          },
        };
      }

      const created = handle.teamTaskStore.createTask({
        id: taskId,
        teamName,
        subject,
        description: params.description,
        owner: params.owner,
        blockedBy,
        metadata: params.metadata,
        createdAt: now,
      });

      if (!created) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create task '${taskId}' (id collision).`,
            },
          ],
          isError: true,
          details: { action: "team_task_create" as const, taskId, teamName },
        };
      }

      const fullTask: TeamTask = created;
      emitTeammateEvent(pi, { kind: "team_task_create", task: fullTask });

      const ownerLabel = fullTask.owner ?? "(unowned)";
      const blockedByLabel = JSON.stringify(fullTask.blockedBy);
      const text =
        `Task ${taskId} created in team '${teamName}'.\n` +
        `  subject: ${subject}\n` +
        `  owner: ${ownerLabel}\n` +
        `  blocked_by: ${blockedByLabel}`;

      const details: TeamTaskCreateDetails = {
        action: "team_task_create",
        taskId,
        teamName,
        subject,
        blockedBy: fullTask.blockedBy,
      };
      if (fullTask.owner !== undefined) {
        details.owner = fullTask.owner;
      }

      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  };
}
